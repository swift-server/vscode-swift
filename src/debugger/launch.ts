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
import { stringArrayInEnglish, swiftLibraryPathKey, swiftRuntimeEnv } from "../utilities/utilities";

/**
 * Edit launch.json based on contents of Swift Package.
 * Adds launch configurations based on the executables in Package.swift.
 *
 * @param ctx folder context to create launch configurations for
 * @param yes automatically answer yes to dialogs
 */
export async function makeDebugConfigurations(ctx: FolderContext, yes = false) {
    if (!configuration.autoGenerateLaunchConfigurations) {
        return;
    }
    const wsLaunchSection = vscode.workspace.getConfiguration("launch", ctx.folder);
    const launchConfigs = wsLaunchSection.get<vscode.DebugConfiguration[]>("configurations") || [];
    // list of keys that can be updated in config merge
    const keysToUpdate = ["program", "cwd", "preLaunchTask", `env.${swiftLibraryPathKey()}`];
    const configUpdates: { index: number; config: vscode.DebugConfiguration }[] = [];

    const configs = createExecutableConfigurations(ctx);
    let edited = false;
    for (const config of configs) {
        const index = launchConfigs.findIndex(c => c.name === config.name);
        if (index !== -1) {
            // deep clone config and update with keys from calculated config
            const newConfig: vscode.DebugConfiguration = JSON.parse(
                JSON.stringify(launchConfigs[index])
            );
            updateConfigWithNewKeys(newConfig, config, keysToUpdate);

            // if original config is different from new config
            if (JSON.stringify(launchConfigs[index]) !== JSON.stringify(newConfig)) {
                configUpdates.push({ index: index, config: newConfig });
            }
        } else {
            launchConfigs.push(config);
            edited = true;
        }
    }

    if (configUpdates.length > 0) {
        if (!yes) {
            const configUpdateNames = stringArrayInEnglish(
                configUpdates.map(update => update.config.name)
            );
            const answer = await vscode.window.showWarningMessage(
                `${ctx.name}: The Swift extension would like to update launch configurations '${configUpdateNames}'. Do you want to update?`,
                "Update",
                "Cancel"
            );
            if (answer === "Update") {
                yes = true;
            }
        }
        if (yes) {
            configUpdates.forEach(update => (launchConfigs[update.index] = update.config));
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
            testEnv.Path = `${xcTestPath};${testEnv.Path ?? process.env.Path}`;
        }
        const sdkroot =
            configuration.destination.sdk === ""
                ? process.env.SDKROOT
                : configuration.destination.sdk;
        if (sdkroot === undefined) {
            return null;
        }
        return {
            type: "lldb",
            request: "launch",
            name: `Test ${ctx.swiftPackage.name}`,
            program: `${folder}/.build/debug/${ctx.swiftPackage.name}PackageTests.xctest`,
            cwd: folder,
            env: testEnv,
            preRunCommands: [`settings set target.sdk-path ${sdkroot}`],
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

/** Return the base configuration with (nested) keys updated with the new one. */
function updateConfigWithNewKeys(
    baseConfiguration: vscode.DebugConfiguration,
    newConfiguration: vscode.DebugConfiguration,
    keys: string[]
) {
    keys.forEach(key => {
        // We're manually handling `undefined`s during nested update, so even if the depth
        // is restricted to 2, the implementation still looks a bit messy.
        if (key.includes(".")) {
            const [mainKey, subKey] = key.split(".", 2);
            if (baseConfiguration[mainKey] === undefined) {
                // { mainKey: unknown | undefined } -> { mainKey: undefined }
                baseConfiguration[mainKey] = newConfiguration[mainKey];
            } else if (newConfiguration[mainKey] === undefined) {
                const subKeys = Object.keys(baseConfiguration[mainKey]);
                if (subKeys.length === 1 && subKeys[0] === subKey) {
                    // { mainKey: undefined } -> { mainKey: { subKey: unknown } }
                    baseConfiguration[mainKey] = undefined;
                } else {
                    // { mainKey: undefined } -> { mainKey: { subKey: unknown | undefined, ... } }
                    baseConfiguration[mainKey][subKey] = undefined;
                }
            } else {
                // { mainKey: { subKey: unknown | undefined } } -> { mainKey: { subKey: unknown | undefined, ... } }
                baseConfiguration[mainKey][subKey] = newConfiguration[mainKey][subKey];
            }
        } else {
            // { key: unknown | undefined } -> { key: unknown | undefined, ... }
            baseConfiguration[key] = newConfiguration[key];
        }
    });
}
