//===----------------------------------------------------------------------===//
//
// This source file is part of the VSCode Swift open source project
//
// Copyright (c) 2022 the VSCode Swift project authors
// Licensed under Apache License v2.0
//
// See LICENSE.txt for license information
// See CONTRIBUTORS.txt for the list of VSCode Swift project authors
//
// SPDX-License-Identifier: Apache-2.0
//
//===----------------------------------------------------------------------===//

import * as vscode from "vscode";
import { pathExists } from "./utilities/utilities";

/**
 * Cache the existence of `Tests/LinuxMain.swift`.
 */
export class LinuxMain {
    private fileWatcher: vscode.FileSystemWatcher;

    constructor(
        folder: vscode.Uri,
        public exists: boolean
    ) {
        this.fileWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(folder, "Tests/LinuxMain.swift"),
            false,
            true
        );
        this.fileWatcher.onDidCreate(() => (this.exists = true));
        this.fileWatcher.onDidDelete(() => (this.exists = false));
    }

    static async create(folder: vscode.Uri): Promise<LinuxMain> {
        const hasLinuxMain = await pathExists(folder.fsPath, "Tests", "LinuxMain.swift");
        return new LinuxMain(folder, hasLinuxMain);
    }

    /**
     * Disposes the {@link vscode.FileSystemWatcher file system watcher} when
     * the extension deactivates.
     */
    dispose() {
        this.fileWatcher?.dispose();
    }
}
