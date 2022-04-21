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

import * as os from "os";
import * as vscode from "vscode";
import configuration from "../configuration";
import { FolderContext } from "../FolderContext";
import { swiftRuntimeEnv } from "../utilities/utilities";

/**
 * Edit launch.json based on contents of Swift Package.
 * Adds launch configurations based on the executables in Package.swift.
 *
 * @param ctx folder context to create launch configurations for
 * @param keysToUpdate configuration keys to update, with maximum nested depth of 2
 */
export async function makeDebugConfigurations(
    ctx: FolderContext,
    keysToUpdate: string[] | undefined = undefined
) {
    if (!configuration.autoGenerateLaunchConfigurations) {
        return;
    }
    const wsLaunchSection = vscode.workspace.getConfiguration("launch", ctx.folder);
    const launchConfigs = wsLaunchSection.get<vscode.DebugConfiguration[]>("configurations") || [];

    const configs = createExecutableConfigurations(ctx);
    let edited = false;
    for (const config of configs) {
        const index = launchConfigs.findIndex(c => c.name === config.name);
        if (index !== -1) {
            if (keysToUpdate && launchConfigs[index] !== config) {
                keysToUpdate.forEach(keyPath => {
                    if (keyPath.includes(".")) {
                        const keys = keyPath.split(".", 2);
                        if (launchConfigs[index][keys[0]] === undefined) {
                            launchConfigs[index][keys[0]] = config[keys[0]];
                        } else if (config[keys[0]] === undefined) {
                            const subkeys = Object.keys(launchConfigs[index][keys[0]]);
                            if (subkeys.length === 1 && subkeys[0] === keys[1]) {
                                launchConfigs[index][keys[0]] = undefined;
                            } else {
                                launchConfigs[index][keys[0]][keys[1]] = undefined;
                            }
                        } else {
                            launchConfigs[index][keys[0]][keys[1]] = config[keys[0]][keys[1]];
                        }
                    } else {
                        launchConfigs[index][keyPath] = config[keyPath];
                    }
                });
                edited = true;
                continue;
            }
            if (
                launchConfigs[index].program !== config.program ||
                launchConfigs[index].cwd !== config.cwd ||
                launchConfigs[index].preLaunchTask !== config.preLaunchTask
            ) {
                const answer = await vscode.window.showErrorMessage(
                    `${ctx.name}: Launch configuration '${config.name}' already exists. Do you want to update it?`,
                    "Cancel",
                    "Update"
                );
                if (answer === "Cancel") {
                    continue;
                }
                launchConfigs[index] = config;
                edited = true;
            }
        } else {
            launchConfigs.push(config);
            edited = true;
        }
    }

    if (edited) {
        await wsLaunchSection.update(
            "configurations",
            launchConfigs,
            vscode.ConfigurationTarget.WorkspaceFolder
        );
    }
}

// Return array of DebugConfigurations for executables based on what is in Package.swift
function createExecutableConfigurations(ctx: FolderContext): vscode.DebugConfiguration[] {
    const executableProducts = ctx.swiftPackage.executableProducts;
    let folder: string;
    let nameSuffix: string;
    if (ctx.relativePath.length === 0) {
        folder = `\${workspaceFolder:${ctx.workspaceFolder.name}}`;
        nameSuffix = "";
    } else {
        folder = `\${workspaceFolder:${ctx.workspaceFolder.name}}/${ctx.relativePath}`;
        nameSuffix = ` (${ctx.relativePath})`;
    }
    return executableProducts.flatMap(product => {
        return [
            {
                type: "lldb",
                request: "launch",
                name: `Debug ${product.name}${nameSuffix}`,
                program: `${folder}/.build/debug/` + product.name,
                args: [],
                cwd: folder,
                preLaunchTask: `swift: Build Debug ${product.name}${nameSuffix}`,
                env: swiftRuntimeEnv(true),
            },
            {
                type: "lldb",
                request: "launch",
                name: `Release ${product.name}${nameSuffix}`,
                program: `${folder}/.build/release/` + product.name,
                args: [],
                cwd: folder,
                preLaunchTask: `swift: Build Release ${product.name}${nameSuffix}`,
                env: swiftRuntimeEnv(true),
            },
        ];
    });
}

/**
 * Return array of DebugConfigurations for tests based on what is in Package.swift
 * @param ctx Folder context
 * @param fullPath should we return configuration with full paths instead of environment vars
 * @returns debug configuration
 */
export function createTestConfiguration(
    ctx: FolderContext,
    fullPath = false
): vscode.DebugConfiguration | null {
    if (ctx.swiftPackage.getTargets("test").length === 0) {
        return null;
    }
    const workspaceFolder = fullPath
        ? ctx.workspaceFolder.uri.fsPath
        : `\${workspaceFolder:${ctx.workspaceFolder.name}}`;

    let folder: string;
    let nameSuffix: string;
    if (ctx.relativePath.length === 0) {
        folder = workspaceFolder;
        nameSuffix = "";
    } else {
        folder = `${workspaceFolder}}/${ctx.relativePath}`;
        nameSuffix = ` (${ctx.relativePath})`;
    }
    // respect user configuration if conflicts with injected runtime path
    const testEnv = {
        ...swiftRuntimeEnv(),
        ...configuration.testEnvironmentVariables,
    };

    if (process.platform === "darwin") {
        // On macOS, find the path to xctest
        // and point it at the .xctest bundle from the .build directory.
        const xctestPath = ctx.workspaceContext.toolchain.xcTestPath;
        if (xctestPath === undefined) {
            return null;
        }
        return {
            type: "lldb",
            request: "launch",
            name: `Test ${ctx.swiftPackage.name}`,
            program: `${xctestPath}/xctest`,
            args: [`.build/debug/${ctx.swiftPackage.name}PackageTests.xctest`],
            cwd: folder,
            env: testEnv,
            preLaunchTask: `swift: Build All${nameSuffix}`,
        };
    } else if (process.platform === "win32") {
        // On Windows, add XCTest.dll to the Path
        // and run the .xctest executable from the .build directory.
        const runtimePath = ctx.workspaceContext.toolchain.runtimePath;
        const xcTestPath = ctx.workspaceContext.toolchain.xcTestPath;
        if (xcTestPath === undefined) {
            return null;
        }
        if (xcTestPath !== runtimePath) {
            testEnv.Path = `${xcTestPath};${testEnv.Path}`;
        }
        return {
            type: "lldb",
            request: "launch",
            name: `Test ${ctx.swiftPackage.name}`,
            program: `${folder}/.build/debug/${ctx.swiftPackage.name}PackageTests.xctest`,
            cwd: folder,
            env: testEnv,
            preLaunchTask: `swift: Build All${nameSuffix}`,
        };
    } else {
        // On Linux, just run the .xctest executable from the .build directory.
        return {
            type: "lldb",
            request: "launch",
            name: `Test ${ctx.swiftPackage.name}`,
            program: `${folder}/.build/debug/${ctx.swiftPackage.name}PackageTests.xctest`,
            cwd: folder,
            env: testEnv,
            preLaunchTask: `swift: Build All${nameSuffix}`,
        };
    }
}

/** Return custom Darwin test configuration that works with Swift 5.6 */
export function createDarwinTestConfiguration(
    ctx: FolderContext,
    args: string,
    outputFile: string
): vscode.DebugConfiguration | null {
    if (ctx.swiftPackage.getTargets("test").length === 0) {
        return null;
    }
    if (process.platform !== "darwin") {
        return null;
    }

    let folder: string;
    let nameSuffix: string;
    if (ctx.relativePath.length === 0) {
        folder = `\${workspaceFolder:${ctx.workspaceFolder.name}}`;
        nameSuffix = "";
    } else {
        folder = `\${workspaceFolder:${ctx.workspaceFolder.name}}/${ctx.relativePath}`;
        nameSuffix = ` (${ctx.relativePath})`;
    }
    // On macOS, find the path to xctest
    // and point it at the .xctest bundle from the .build directory.
    const xctestPath = ctx.workspaceContext.toolchain.xcTestPath;
    if (xctestPath === undefined) {
        return null;
    }
    let arch: string;
    switch (os.arch()) {
        case "x64":
            arch = "x86_64";
            break;
        case "arm64":
            arch = "arm64e";
            break;
        default:
            return null;
    }
    const envCommands = Object.entries({
        ...swiftRuntimeEnv(),
        ...configuration.testEnvironmentVariables,
    }).map(([key, value]) => `settings set target.env-vars ${key}="${value}"`);

    return {
        type: "lldb",
        request: "custom",
        name: `Test ${ctx.swiftPackage.name}`,
        targetCreateCommands: [`file -a ${arch} ${xctestPath}/xctest`],
        processCreateCommands: [
            ...envCommands,
            `process launch -e ${outputFile} -w ${folder} -- ${args} .build/debug/${ctx.swiftPackage.name}PackageTests.xctest`,
        ],
        preLaunchTask: `swift: Build All${nameSuffix}`,
    };
}
