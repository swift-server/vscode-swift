//===----------------------------------------------------------------------===//
//
// This source file is part of the VSCode Swift open source project
//
// Copyright (c) 2021 the VSCode Swift project authors
// Licensed under Apache License v2.0
//
// See LICENSE.txt for license information
// See CONTRIBUTORS.txt for the list of VSCode Swift project authors
//
// SPDX-License-Identifier: Apache-2.0
//
//===----------------------------------------------------------------------===//

import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import configuration from "../configuration";
import { WorkspaceContext } from "../WorkspaceContext";
import { FolderEvent } from "../WorkspaceContext";
import { FolderContext } from "../FolderContext";
import contextKeys from "../contextKeys";
import {
    Dependency,
    PackageContents,
    SwiftPackage,
    WorkspaceState,
    WorkspaceStateDependency,
} from "../SwiftPackage";
import { BuildFlags } from "../toolchain/BuildFlags";

/**
 * References:
 *
 * - Contributing views:
 *   https://code.visualstudio.com/api/references/contribution-points#contributes.views
 * - Contributing welcome views:
 *   https://code.visualstudio.com/api/references/contribution-points#contributes.viewsWelcome
 * - Implementing a TreeView:
 *   https://code.visualstudio.com/api/extension-guides/tree-view
 */

/**
 * A package in the Package Dependencies {@link vscode.TreeView TreeView}.
 */
export class PackageNode {
    constructor(
        public name: string,
        public path: string,
        public location: string,
        public version: string,
        public type: "local" | "remote" | "editing"
    ) {}

    toTreeItem(): vscode.TreeItem {
        const item = new vscode.TreeItem(this.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = this.path;
        item.description = this.version;
        item.iconPath =
            this.type === "editing"
                ? new vscode.ThemeIcon("edit")
                : new vscode.ThemeIcon("package");
        item.contextValue = this.type;
        item.accessibilityInformation = { label: `Package ${this.name}` };
        return item;
    }
}

/**
 * A file or directory in the Package Dependencies {@link vscode.TreeView TreeView}.
 */
class FileNode {
    constructor(
        public name: string,
        public path: string,
        public isDirectory: boolean
    ) {}

    toTreeItem(): vscode.TreeItem {
        const item = new vscode.TreeItem(
            this.name,
            this.isDirectory
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
        );
        item.id = this.path;
        item.resourceUri = vscode.Uri.file(this.path);
        if (!this.isDirectory) {
            item.command = {
                command: "vscode.open",
                arguments: [item.resourceUri],
                title: "Open File",
            };
            item.accessibilityInformation = { label: `File ${this.name}` };
        } else {
            item.accessibilityInformation = { label: `Folder ${this.name}` };
        }
        return item;
    }
}

/**
 * A node in the Package Dependencies {@link vscode.TreeView TreeView}.
 *
 * Can be either a {@link PackageNode} or a {@link FileNode}.
 */
type TreeNode = PackageNode | FileNode;

/**
 * A {@link vscode.TreeDataProvider TreeDataProvider} for the Package Dependencies {@link vscode.TreeView TreeView}.
 */
export class PackageDependenciesProvider implements vscode.TreeDataProvider<TreeNode> {
    private didChangeTreeDataEmitter = new vscode.EventEmitter<
        TreeNode | undefined | null | void
    >();
    private workspaceObserver?: vscode.Disposable;

    onDidChangeTreeData = this.didChangeTreeDataEmitter.event;

    constructor(private workspaceContext: WorkspaceContext) {
        // default context key to false. These will be updated as folders are given focus
        contextKeys.hasPackage = false;
        contextKeys.packageHasDependencies = false;
    }

    dispose() {
        this.workspaceObserver?.dispose();
    }

    observeFolders(treeView: vscode.TreeView<TreeNode>) {
        this.workspaceObserver = this.workspaceContext.observeFolders((folder, event) => {
            switch (event) {
                case FolderEvent.focus:
                    if (!folder) {
                        return;
                    }
                    treeView.title = `Package Dependencies (${folder.name})`;
                    this.didChangeTreeDataEmitter.fire();
                    break;
                case FolderEvent.unfocus:
                    treeView.title = `Package Dependencies`;
                    this.didChangeTreeDataEmitter.fire();
                    break;
                case FolderEvent.resolvedUpdated:
                    if (!folder) {
                        return;
                    }
                    if (folder === this.workspaceContext.currentFolder) {
                        this.didChangeTreeDataEmitter.fire();
                    }
            }
        });
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        return element.toTreeItem();
    }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        const folderContext = this.workspaceContext.currentFolder;
        if (!folderContext) {
            return [];
        }
        if (!element) {
            const workspaceState = await folderContext.swiftPackage.loadWorkspaceState();
            return await this.getDependencyGraph(workspaceState, folderContext);
        }

        return this.getNodesInDirectory(element.path);
    }

    private async getDependencyGraph(
        workspaceState: WorkspaceState | undefined,
        folderContext: FolderContext
    ): Promise<PackageNode[]> {
        if (!workspaceState) {
            return [];
        }
        const inUseDependencies = await this.getInUseDependencies(workspaceState, folderContext);
        return (
            workspaceState?.object.dependencies
                .filter(dependency =>
                    inUseDependencies.has(dependency.packageRef.identity.toLowerCase())
                )
                .map(dependency => {
                    const type = this.dependencyType(dependency);
                    const version = this.dependencyDisplayVersion(dependency);
                    const packagePath = this.dependencyPackagePath(
                        dependency,
                        folderContext.folder.fsPath
                    );
                    const location = dependency.packageRef.location;
                    return new PackageNode(
                        dependency.packageRef.identity,
                        packagePath,
                        location,
                        version,
                        type
                    );
                }) ?? []
        );
    }

    /**
     * * Returns a set of all dependencies that are in use in the workspace.
     * Why tranverse is necessary here?
     *  * If we have an implicit local dependency of a dependency, you may not be able to see it in either `Package.swift` or `Package.resolved` unless tranversing from root Package.swift.
     * Why not using `swift package show-dependencies`?
     *  * it costs more time and it triggers the file change of `workspace-state.json` which is not necessary
     * Why not using `workspace-state.json` directly?
     *  * `workspace-state.json` contains all necessary dependencies but it also contains dependencies that are not in use.
     * Here is the implementation details:
     * 1. local/remote/edited dependency has remote/edited dependencies, Package.resolved covers them
     * 2. remote/edited dependency has a local dependency, the local dependency must have been declared in root Package.swift
     * 3. local dependency has a local dependency, traverse it and find the local dependencies only recursively
     * 4. pins include all remote and edited packages for 1, 2
     */
    private async getInUseDependencies(
        workspaceState: WorkspaceState,
        folderContext: FolderContext
    ): Promise<Set<string>> {
        const localDependencies = await this.getLocalDependencySet(workspaceState, folderContext);
        const remoteDependencies = this.getRemoteDependencySet(folderContext);
        const editedDependencies = this.getEditedDependencySet(workspaceState);
        return new Set<string>([
            ...localDependencies,
            ...remoteDependencies,
            ...editedDependencies,
        ]);
    }

    private getRemoteDependencySet(folderContext: FolderContext | undefined): Set<string> {
        return new Set<string>(folderContext?.swiftPackage.resolved?.pins.map(pin => pin.identity));
    }

    private getEditedDependencySet(workspaceState: WorkspaceState): Set<string> {
        return new Set<string>(
            workspaceState.object.dependencies
                .filter(dependency => this.dependencyType(dependency) === "editing")
                .map(dependency => dependency.packageRef.identity)
        );
    }

    /**
     * @param workspaceState the workspace state read from `Workspace-state.json`
     * @param folderContext the folder context of the current folder
     * @returns all local in-use dependencies
     */
    private async getLocalDependencySet(
        workspaceState: WorkspaceState,
        folderContext: FolderContext
    ): Promise<Set<string>> {
        const rootDependencies = folderContext.swiftPackage.dependencies ?? [];
        const workspaceStateDependencies = workspaceState.object.dependencies ?? [];
        const workspacePath = folderContext.folder.fsPath;

        const showingDependencies: Set<string> = new Set<string>();
        const stack: Dependency[] = rootDependencies;

        while (stack.length > 0) {
            const top = stack.pop();
            if (!top) {
                continue;
            }

            if (showingDependencies.has(top.identity)) {
                continue;
            }

            if (top.type !== "local" && top.type !== "fileSystem") {
                continue;
            }

            showingDependencies.add(top.identity);
            const workspaceStateDependency = workspaceStateDependencies.find(
                workspaceStateDependency =>
                    workspaceStateDependency.packageRef.identity === top.identity
            );
            if (!workspaceStateDependency) {
                continue;
            }

            const packagePath = this.dependencyPackagePath(workspaceStateDependency, workspacePath);
            const childDependencyContents = (await SwiftPackage.loadPackage(
                vscode.Uri.file(packagePath),
                this.workspaceContext.toolchain
            )) as PackageContents;

            stack.push(...childDependencyContents.dependencies);
        }
        return showingDependencies;
    }

    /**
     * Returns a {@link PackageNode} for every local dependency
     * declared in **Package.swift**.
     */
    private getLocalDependencies(workspaceState: WorkspaceState | undefined): PackageNode[] {
        return (
            workspaceState?.object.dependencies
                .filter(item => {
                    // need to check for both "local" and "fileSystem" as swift 5.5 and earlier
                    // use "local" while 5.6 and later use "fileSystem"
                    return (
                        (item.packageRef.kind === "local" ||
                            item.packageRef.kind === "fileSystem") &&
                        item.packageRef.location
                    );
                })
                .map(
                    dependency =>
                        new PackageNode(
                            dependency.packageRef.identity,
                            dependency.packageRef.location,
                            dependency.packageRef.location,
                            "local",
                            "local"
                        )
                ) ?? []
        );
    }

    /**
     * Returns a {@link PackageNode} for every remote dependency.
     */
    private getRemoteDependencies(folderContext: FolderContext): PackageNode[] {
        return (
            folderContext.swiftPackage.resolved?.pins.map(
                pin =>
                    new PackageNode(
                        pin.identity,
                        pin.location,
                        pin.location,
                        pin.state.version ?? pin.state.branch ?? pin.state.revision.substring(0, 7),
                        "remote"
                    )
            ) ?? []
        );
    }

    /**
     * Return list of package dependencies in edit mode
     * @param folderContext Folder to get edited dependencies for
     * @returns Array of packages
     */
    private getEditedDependencies(workspaceState: WorkspaceState | undefined): PackageNode[] {
        return (
            workspaceState?.object.dependencies
                .filter(item => {
                    return item.state.name === "edited" && item.state.path;
                })
                .map(
                    item =>
                        new PackageNode(
                            item.packageRef.identity,
                            item.state.path!,
                            item.state.path!,
                            "local",
                            "editing"
                        )
                ) ?? []
        );
    }

    /**
     * Returns a {@link FileNode} for every file or subdirectory
     * in the given directory.
     */
    private async getNodesInDirectory(directoryPath: string): Promise<FileNode[]> {
        const contents = await fs.readdir(directoryPath);
        const results: FileNode[] = [];
        const excludes = configuration.excludePathsFromPackageDependencies;
        for (const fileName of contents) {
            if (excludes.includes(fileName)) {
                continue;
            }
            const filePath = path.join(directoryPath, fileName);
            const stats = await fs.stat(filePath);
            results.push(new FileNode(fileName, filePath, stats.isDirectory()));
        }
        return results.sort((first, second) => {
            if (first.isDirectory === second.isDirectory) {
                // If both nodes are of the same type, sort them by name.
                return first.name.localeCompare(second.name);
            } else {
                // Otherwise, sort directories first.
                return first.isDirectory ? -1 : 1;
            }
        });
    }

    /// - Dependency display helpers

    /**
     * Get type of WorkspaceStateDependency for displaying in the tree: real version | edited | local
     * @param dependency
     * @return "local" | "remote" | "editing"
     */
    private dependencyType(dependency: WorkspaceStateDependency): "local" | "remote" | "editing" {
        if (dependency.state.name === "edited") {
            return "editing";
        } else if (
            dependency.packageRef.kind === "local" ||
            dependency.packageRef.kind === "fileSystem"
        ) {
            // need to check for both "local" and "fileSystem" as swift 5.5 and earlier
            // use "local" while 5.6 and later use "fileSystem"
            return "local";
        } else {
            return "remote";
        }
    }

    /**
     * Get version of WorkspaceStateDependency for displaying in the tree
     * @param dependency
     * @return real version | editing | local
     */
    private dependencyDisplayVersion(dependency: WorkspaceStateDependency): string {
        const type = this.dependencyType(dependency);
        if (type === "editing") {
            return "editing";
        } else if (type === "local") {
            return "local";
        } else {
            return (
                dependency.state.checkoutState?.version ??
                dependency.state.checkoutState?.branch ??
                dependency.state.checkoutState?.revision.substring(0, 7) ??
                "unknown"
            );
        }
    }

    /**
     *  * Get package source path of dependency
     * `editing`: dependency.state.path ?? workspacePath + Packages/ + dependency.subpath
     * `local`: dependency.packageRef.location
     * `remote`: buildDirectory + checkouts + dependency.packageRef.location
     * @param dependency
     * @param workspaceFolder
     * @return the package path based on the type
     */
    private dependencyPackagePath(
        dependency: WorkspaceStateDependency,
        workspaceFolder: string
    ): string {
        const type = this.dependencyType(dependency);
        if (type === "editing") {
            return (
                dependency.state.path ?? path.join(workspaceFolder, "Packages", dependency.subpath)
            );
        } else if (type === "local") {
            return dependency.state.path ?? dependency.packageRef.location;
        } else {
            // remote
            const buildDirectory = BuildFlags.buildDirectoryFromWorkspacePath(
                workspaceFolder,
                true
            );
            return path.join(buildDirectory, "checkouts", dependency.subpath);
        }
    }
}
