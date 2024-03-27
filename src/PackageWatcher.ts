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
import { FolderContext } from "./FolderContext";
import { FolderEvent, WorkspaceContext } from "./WorkspaceContext";

/**
 * Watches for changes to **Package.swift** and **Package.resolved**.
 *
 * Any changes to these files will update the context keys, trigger a `resolve` task,
 * and update the Package Dependencies view.
 */
export class PackageWatcher {
    private packageFileWatcher?: vscode.FileSystemWatcher;
    private resolvedFileWatcher?: vscode.FileSystemWatcher;

    constructor(
        private folderContext: FolderContext,
        private workspaceContext: WorkspaceContext
    ) {}

    /**
     * Creates and installs {@link vscode.FileSystemWatcher file system watchers} for
     * **Package.swift** and **Package.resolved**.
     */
    install() {
        this.packageFileWatcher = this.createPackageFileWatcher();
        this.resolvedFileWatcher = this.createResolvedFileWatcher();
    }

    /**
     * Disposes the {@link vscode.FileSystemWatcher file system watchers}
     * when the extension deactivates.
     */
    dispose() {
        this.packageFileWatcher?.dispose();
        this.resolvedFileWatcher?.dispose();
    }

    private createPackageFileWatcher(): vscode.FileSystemWatcher {
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.folderContext.folder, "Package.swift")
        );
        watcher.onDidCreate(async () => await this.handlePackageSwiftChange());
        watcher.onDidChange(async () => await this.handlePackageSwiftChange());
        watcher.onDidDelete(async () => await this.handlePackageSwiftChange());
        return watcher;
    }

    private createResolvedFileWatcher(): vscode.FileSystemWatcher {
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.folderContext.folder, "Package.resolved")
        );
        watcher.onDidCreate(async () => await this.handlePackageResolvedChange());
        watcher.onDidChange(async () => await this.handlePackageResolvedChange());
        watcher.onDidDelete(async () => await this.handlePackageResolvedChange());
        return watcher;
    }

    /**
     * Handles a create or change event for **Package.swift**.
     *
     * This will reload the swift package description, update the
     * launch configuration if required and then resolve the package
     * dependencies.
     */
    async handlePackageSwiftChange() {
        // Load SwiftPM Package.swift description
        await this.folderContext.reload();
        this.workspaceContext.fireEvent(this.folderContext, FolderEvent.packageUpdated);
    }

    /**
     * Handles a create or change event for **Package.resolved**.
     *
     * This will resolve any changes in the Package.resolved.
     */
    private async handlePackageResolvedChange() {
        const packageResolvedHash = this.folderContext.swiftPackage.resolved?.fileHash;
        await this.folderContext.reloadPackageResolved();
        // if file contents has changed then send resolve updated message
        if (this.folderContext.swiftPackage.resolved?.fileHash !== packageResolvedHash) {
            this.workspaceContext.fireEvent(this.folderContext, FolderEvent.resolvedUpdated);
        }
    }
}
