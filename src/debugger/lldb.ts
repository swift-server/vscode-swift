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

// Based on code taken from CodeLLDB https://github.com/vadimcn/vscode-lldb/
// LICENSED with MIT License

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { execFile } from "../utilities/utilities";
import { Result } from "../utilities/result";
import { SwiftToolchain } from "../toolchain/toolchain";
import configuration from "../configuration";

/**
 * Check if CodeLLDB extension is installed and offer to install it if it is not.
 * @returns Whether extension was installed
 */
export async function checkLLDBInstalled(): Promise<boolean> {
    const lldbExtension = vscode.extensions.getExtension("vadimcn.vscode-lldb");
    // if extension is in list return true
    if (lldbExtension) {
        return true;
    }
    // if workspace is set to ignore LLDB check then return
    if (configuration.skipCodeLLDBCheck === true) {
        return false;
    }
    // otherwise display menu asking if user wants to install it
    return new Promise<boolean>((resolve, reject) => {
        vscode.window
            .showWarningMessage(
                "Do you want to install the CodeLLDB extension?",
                {
                    modal: true,
                    detail: "The Swift extension requires it to enable debugging.",
                },
                "Install"
            )
            .then(async result => {
                switch (result) {
                    case "Install":
                        try {
                            await installCodeLLDB();
                            return resolve(true);
                        } catch (error) {
                            return reject(error);
                        }
                    case undefined:
                        break;
                }
                return resolve(false);
            });
    });
}

/**
 * Install CodeLLDB extension
 */
async function installCodeLLDB() {
    await vscode.commands.executeCommand(
        "workbench.extensions.installExtension",
        "vadimcn.vscode-lldb"
    );
}

/**
 * Get LLDB library for given LLDB executable
 * @param executable LLDB executable
 * @returns Library path for LLDB
 */
export async function getLLDBLibPath(toolchain: SwiftToolchain): Promise<Result<string>> {
    // can't use toolchain path here as LLDB is not in macOS toolchain path
    const executable = path.join(toolchain.swiftFolderPath, "lldb");
    let pathHint = path.dirname(toolchain.swiftFolderPath);
    try {
        const statement = `print('<!' + lldb.SBHostOS.GetLLDBPath(lldb.ePathTypeLLDBShlibDir).fullpath + '!>')`;
        const args = ["-b", "-O", `script ${statement}`];
        const { stdout } = await execFile(executable, args);
        const m = /^<!([^!]*)!>/m.exec(stdout);
        if (m) {
            pathHint = m[1];
        }
    } catch (error) {
        // If we get an error on Windows here we should not attempt to use the fallback path. If it failed
        // it is most likely due to lldb failing to run because $PYHTONHOME environment variable is setup
        // incorrectly (this is the case in Swift < 5.7). In this situation swift lldb does not work so we
        // should just the version of lldb that comes with CodeLLDB. We return a failure with no message
        // to indicate we want it to fail silently.
        if (process.platform === "win32") {
            return Result.makeFailure(undefined);
        }
    }
    const lldbPath = await findLibLLDB(pathHint);
    if (lldbPath) {
        return Result.makeSuccess(lldbPath);
    } else {
        return Result.makeFailure("LLDB failed to provide a library path");
    }
}

async function findLibLLDB(pathHint: string): Promise<string | undefined> {
    const stat = await fs.stat(pathHint);
    if (stat.isFile()) {
        return pathHint;
    }

    let libDir;
    let pattern;
    if (process.platform === "linux") {
        libDir = path.join(pathHint, "lib");
        pattern = /liblldb.*\.so.*/;
    } else if (process.platform === "darwin") {
        libDir = path.join(pathHint, "lib");
        pattern = /liblldb\..*dylib|LLDB/;
    } else if (process.platform === "win32") {
        libDir = path.join(pathHint, "bin");
        pattern = /liblldb\.dll/;
    } else {
        return pathHint;
    }

    for (const dir of [pathHint, libDir]) {
        const file = await findFileByPattern(dir, pattern);
        if (file) {
            return path.join(dir, file);
        }
    }
    return undefined;
}

async function findFileByPattern(path: string, pattern: RegExp): Promise<string | null> {
    try {
        const files = await fs.readdir(path);
        for (const file of files) {
            if (pattern.test(file)) {
                return file;
            }
        }
    } catch (err) {
        // Ignore missing directories and such...
    }
    return null;
}
