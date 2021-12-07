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

import * as vscode from 'vscode';
import * as debug from './debug';
import commands from './commands';
import { SwiftContext } from './SwiftContext';

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
        private workspaceRoot: string, 
        private ctx: SwiftContext) {
    }

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
            new vscode.RelativePattern(this.workspaceRoot, 'Package.swift')
        );
        watcher.onDidCreate(async () => await this.handlePackageSwiftChange());
        watcher.onDidChange(async () => await this.handlePackageSwiftChange());
        watcher.onDidDelete(async () => await this.handlePackageSwiftChange());
        return watcher;
    }

    private createResolvedFileWatcher(): vscode.FileSystemWatcher {
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.workspaceRoot, 'Package.resolved')
        );
        watcher.onDidCreate(async () => await this.handlePackageResolvedChange());
        watcher.onDidChange(async () => await this.handlePackageResolvedChange());
        watcher.onDidDelete(async () => await this.handlePackageResolvedChange());
        return watcher;
    }

    /**
     * Handles a create or change event for **Package.swift** and **Package.resolved**.
     * 
     * This will update the context keys and trigger a `resolve` task,
     * which will in turn update the Package Dependencies view.
     */
     async handlePackageSwiftChange() {
        await this.ctx.swiftPackage.reload();
        debug.makeDebugConfigurations(this.ctx);
        if (this.ctx.swiftPackage.dependencies.length > 0) {
            await commands.resolveDependencies();
        }
    }

    /**
     * Handles a create or change event for **Package.swift** and **Package.resolved**.
     * 
     * This will update the context keys and trigger a `resolve` task,
     * which will in turn update the Package Dependencies view.
     */
     async handlePackageResolvedChange() {
        if (this.ctx.swiftPackage.dependencies.length > 0) {
            await commands.resolveDependencies();
        }
    }
}
