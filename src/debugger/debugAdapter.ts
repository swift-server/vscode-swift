//===----------------------------------------------------------------------===//
//
// This source file is part of the VSCode Swift open source project
//
// Copyright (c) 2023 the VSCode Swift project authors
// Licensed under Apache License v2.0
//
// See LICENSE.txt for license information
// See CONTRIBUTORS.txt for the list of VSCode Swift project authors
//
// SPDX-License-Identifier: Apache-2.0
//
//===----------------------------------------------------------------------===//

import * as vscode from "vscode";
import * as fs from "fs";
import { WorkspaceContext } from "../WorkspaceContext";
import configuration from "../configuration";

/**
 * Class managing which debug adapter we are using. Will only setup lldb-vscode if it is available.
 */
export class DebugAdapter {
    static debugAdapaterExists = false;

    /** Debug adapter name */
    static get adapterName(): string {
        return configuration.debugger.useDebugAdapterFromToolchain && this.debugAdapaterExists
            ? "swift-lldb"
            : "lldb";
    }

    /**
     * Verify that the toolchain debug adapter exists
     * @param workspace WorkspaceContext
     * @param quiet Should dialog be displayed
     * @returns Is debugger available
     */
    static async verifyDebugAdapterExists(
        workspace: WorkspaceContext,
        quiet = false
    ): Promise<boolean> {
        const useCustom = configuration.debugger.debugAdapterPath.length > 0;
        const lldbDebugAdapterPath = useCustom
            ? configuration.debugger.debugAdapterPath
            : workspace.toolchain.getToolchainExecutable("lldb-vscode");
        if (!(await this.doesFileExist(lldbDebugAdapterPath))) {
            if (!quiet) {
                vscode.window.showInformationMessage(
                    useCustom
                        ? "Cannot find lldb-vscode debug adapter specified in setting Swift.Debugger.Path."
                        : "Cannot find lldb-vscode debug adapter in your Swift toolchain."
                );
            }
            workspace.outputChannel.log(`Failed to find ${lldbDebugAdapterPath}`);
            this.debugAdapaterExists = false;
            return false;
        }
        this.debugAdapaterExists = true;
        return true;
    }

    private static async doesFileExist(path: string): Promise<boolean> {
        try {
            return (await fs.promises.stat(path)).isFile();
        } catch (e) {
            return false;
        }
    }
}
