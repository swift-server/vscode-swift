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
import * as path from "path";
import { LinuxMain } from "./LinuxMain";
import { PackageWatcher } from "./PackageWatcher";
import { SwiftPackage } from "./SwiftPackage";
import { TestExplorer } from "./TestExplorer/TestExplorer";
import { WorkspaceContext, FolderEvent } from "./WorkspaceContext";

export class FolderContext implements vscode.Disposable {
    private packageWatcher?: PackageWatcher;
    public hasResolveErrors = false;
    public testExplorer?: TestExplorer;

    /**
     * FolderContext constructor
     * @param folder Workspace Folder
     * @param swiftPackage Swift Package inside the folder
     * @param workspaceContext Workspace context
     */
    private constructor(
        public folder: vscode.Uri,
        public linuxMain: LinuxMain,
        public swiftPackage: SwiftPackage,
        public workspaceFolder: vscode.WorkspaceFolder,
        public workspaceContext: WorkspaceContext
    ) {
        this.packageWatcher = new PackageWatcher(this, workspaceContext);
        this.packageWatcher.install();
    }

    /** dispose of any thing FolderContext holds */
    dispose() {
        this.linuxMain?.dispose();
        this.packageWatcher?.dispose();
        this.testExplorer?.dispose();
    }

    /**
     * Create FolderContext
     * @param folder Folder that Folder Context is being created for
     * @param workspaceContext Workspace context for extension
     * @returns a new FolderContext
     */
    static async create(
        folder: vscode.Uri,
        workspaceFolder: vscode.WorkspaceFolder,
        workspaceContext: WorkspaceContext
    ): Promise<FolderContext> {
        const statusItemText = `Loading Package (${FolderContext.uriName(folder)})`;
        workspaceContext.statusItem.start(statusItemText);

        const linuxMain = await LinuxMain.create(folder);
        const swiftPackage = await SwiftPackage.create(folder);

        workspaceContext.statusItem.end(statusItemText);

        return new FolderContext(
            folder,
            linuxMain,
            swiftPackage,
            workspaceFolder,
            workspaceContext
        );
    }

    get name(): string {
        const relativePath = this.relativePath;
        if (relativePath.length === 0) {
            return this.workspaceFolder.name;
        } else {
            return `${this.workspaceFolder.name}/${this.relativePath}`;
        }
    }

    get relativePath(): string {
        return path.relative(this.workspaceFolder.uri.fsPath, this.folder.fsPath);
    }

    /** reload swift package for this folder */
    async reload() {
        await this.swiftPackage.reload();
    }

    /** reload Package.resolved for this folder */
    async reloadPackageResolved() {
        await this.swiftPackage.reloadPackageResolved();
    }

    /**
     * Fire an event to all folder observers
     * @param event event type
     */
    async fireEvent(event: FolderEvent) {
        this.workspaceContext.fireEvent(this, event);
    }

    /** Return edited Packages folder */
    editedPackageFolder(identifier: string) {
        return path.join(this.folder.fsPath, "Packages", identifier);
    }

    /** Create Test explorer for this folder */
    addTestExplorer() {
        this.testExplorer = new TestExplorer(this);
    }

    /** Get list of edited packages */
    async getEditedPackages(): Promise<EditedPackage[]> {
        const workspaceState = await this.swiftPackage.loadWorkspaceState();
        return (
            workspaceState?.object.dependencies
                .filter(item => {
                    return item.state.name === "edited" && item.state.path;
                })
                .map(item => {
                    return { name: item.packageRef.identity, folder: item.state.path! };
                }) ?? []
        );
    }

    static uriName(uri: vscode.Uri): string {
        return path.basename(uri.fsPath);
    }
}

export interface EditedPackage {
    name: string;
    folder: string;
}
