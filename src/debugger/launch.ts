//===----------------------------------------------------------------------===//
//
// This source file is part of the VSCode Swift open source project
//
// Copyright (c) 2021-2023 the VSCode Swift project authors
// Licensed under Apache License v2.0
//
// See LICENSE.txt for license information
// See CONTRIBUTORS.txt for the list of VSCode Swift project authors
//
// SPDX-License-Identifier: Apache-2.0
//
//===----------------------------------------------------------------------===//

import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import configuration from "../configuration";
import { FolderContext } from "../FolderContext";
import { BuildFlags } from "../toolchain/BuildFlags";
import { stringArrayInEnglish, swiftLibraryPathKey, swiftRuntimeEnv } from "../utilities/utilities";
import { DebugAdapter } from "./debugAdapter";

/**
 * Edit launch.json based on contents of Swift Package.
 * Adds launch configurations based on the executables in Package.swift.
 *
 * @param ctx folder context to create launch configurations for
 * @param yes automatically answer yes to dialogs
 */
export async function makeDebugConfigurations(ctx: FolderContext, message?: string, yes = false) {
    if (!configuration.folder(ctx.workspaceFolder).autoGenerateLaunchConfigurations) {
        return;
    }
    const wsLaunchSection = vscode.workspace.getConfiguration("launch", ctx.folder);
    const launchConfigs = wsLaunchSection.get<vscode.DebugConfiguration[]>("configurations") || [];
    // list of keys that can be updated in config merge
    const keysToUpdate = [
        "program",
        "cwd",
        "preLaunchTask",
        "type",
        `env.${swiftLibraryPathKey()}`,
    ];
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
            const warningMessage =
                message ??
                `The Swift extension would like to update launch configurations '${configUpdateNames}'.`;
            const answer = await vscode.window.showWarningMessage(
                `${ctx.name}: ${warningMessage} Do you want to update?`,
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

// Return debug launch configuration for an executable in the given folder
export function getLaunchConfiguration(
    target: string,
    folderCtx: FolderContext
): vscode.DebugConfiguration | undefined {
    const wsLaunchSection = vscode.workspace.getConfiguration("launch", folderCtx.folder);
    const launchConfigs = wsLaunchSection.get<vscode.DebugConfiguration[]>("configurations") || [];
    const { folder } = getFolderAndNameSuffix(folderCtx);
    const buildDirectory = BuildFlags.buildDirectoryFromWorkspacePath(folder, true);
    return launchConfigs.find(config => config.program === `${buildDirectory}/debug/` + target);
}

// Return array of DebugConfigurations for executables based on what is in Package.swift
function createExecutableConfigurations(ctx: FolderContext): vscode.DebugConfiguration[] {
    const executableProducts = ctx.swiftPackage.executableProducts;
    const { folder, nameSuffix } = getFolderAndNameSuffix(ctx);
    const buildDirectory = BuildFlags.buildDirectoryFromWorkspacePath(folder, true);
    const binaryExtension = process.platform === "win32" ? ".exe" : "";
    return executableProducts.flatMap(product => {
        return [
            {
                type: DebugAdapter.adapterName,
                request: "launch",
                sourceLanguages: ["swift"],
                name: `Debug ${product.name}${nameSuffix}`,
                program: path.join(buildDirectory, "debug", product.name + binaryExtension),
                args: [],
                cwd: folder,
                preLaunchTask: `swift: Build Debug ${product.name}${nameSuffix}`,
                env: swiftRuntimeEnv(true),
            },
            {
                type: DebugAdapter.adapterName,
                request: "launch",
                sourceLanguages: ["swift"],
                name: `Release ${product.name}${nameSuffix}`,
                program: path.join(buildDirectory, "release", product.name + binaryExtension),
                args: [],
                cwd: folder,
                preLaunchTask: `swift: Build Release ${product.name}${nameSuffix}`,
                env: swiftRuntimeEnv(true),
            },
        ];
    });
}

/**
 * Create Debug configuration for running a Swift Snippet
 * @param snippetName Name of Swift Snippet to run
 * @param ctx Folder context for project
 * @returns Debug configuration for running Swift Snippet
 */
export function createSnippetConfiguration(
    snippetName: string,
    ctx: FolderContext
): vscode.DebugConfiguration {
    const { folder } = getFolderAndNameSuffix(ctx);
    const buildDirectory = BuildFlags.buildDirectoryFromWorkspacePath(folder, true);

    return {
        type: DebugAdapter.adapterName,
        request: "launch",
        sourceLanguages: ["swift"],
        name: `Run ${snippetName}`,
        program: path.join(buildDirectory, "debug", snippetName),
        args: [],
        cwd: folder,
        env: swiftRuntimeEnv(true),
    };
}

/**
 * Return array of DebugConfigurations for tests based on what is in Package.swift
 * @param ctx Folder context
 * @param fullPath should we return configuration with full paths instead of environment vars
 * @returns debug configuration
 */
export function createTestConfiguration(
    ctx: FolderContext,
    expandEnvVariables = false
): vscode.DebugConfiguration | null {
    if (ctx.swiftPackage.getTargets("test").length === 0) {
        return null;
    }

    // respect user configuration if conflicts with injected runtime path
    const testEnv = {
        ...swiftRuntimeEnv(),
        ...configuration.folder(ctx.workspaceFolder).testEnvironmentVariables,
    };
    const { folder, nameSuffix } = getFolderAndNameSuffix(ctx, expandEnvVariables);
    const buildDirectory = BuildFlags.buildDirectoryFromWorkspacePath(folder, true);

    if (process.platform === "darwin") {
        // On macOS, find the path to xctest
        // and point it at the .xctest bundle from the configured build directory.
        const xctestPath = ctx.workspaceContext.toolchain.xcTestPath;
        if (xctestPath === undefined) {
            return null;
        }
        const sanitizer = ctx.workspaceContext.toolchain.sanitizer(configuration.sanitizer);
        const env = { ...testEnv, ...sanitizer?.runtimeEnvironment };
        return {
            type: DebugAdapter.adapterName,
            request: "launch",
            sourceLanguages: ["swift"],
            name: `Test ${ctx.swiftPackage.name}`,
            program: `${xctestPath}/xctest`,
            args: [`${buildDirectory}/debug/${ctx.swiftPackage.name}PackageTests.xctest`],
            cwd: folder,
            env: env,
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
        const sdkroot = configuration.sdk === "" ? process.env.SDKROOT : configuration.sdk;
        if (sdkroot === undefined) {
            return null;
        }
        let preRunCommands: string[] | undefined;
        if (
            configuration.debugger.useDebugAdapterFromToolchain ||
            vscode.workspace.getConfiguration("lldb")?.get<string>("library")
        ) {
            preRunCommands = [`settings set target.sdk-path ${sdkroot}`];
        }
        return {
            type: DebugAdapter.adapterName,
            request: "launch",
            sourceLanguages: ["swift"],
            name: `Test ${ctx.swiftPackage.name}`,
            program: path.join(
                buildDirectory,
                "debug",
                ctx.swiftPackage.name + "PackageTests.xctest"
            ),
            cwd: folder,
            env: testEnv,
            preRunCommands: preRunCommands,
            preLaunchTask: `swift: Build All${nameSuffix}`,
        };
    } else {
        // On Linux, just run the .xctest executable from the configured build directory.
        return {
            type: DebugAdapter.adapterName,
            request: "launch",
            sourceLanguages: ["swift"],
            name: `Test ${ctx.swiftPackage.name}`,
            program: `${buildDirectory}/debug/${ctx.swiftPackage.name}PackageTests.xctest`,
            cwd: folder,
            env: testEnv,
            preLaunchTask: `swift: Build All${nameSuffix}`,
        };
    }
}

/** Return custom Darwin test configuration that works with Swift 5.6 */
export function createDarwinTestConfiguration(
    ctx: FolderContext,
    args: string
): vscode.DebugConfiguration | null {
    if (ctx.swiftPackage.getTargets("test").length === 0) {
        return null;
    }
    if (process.platform !== "darwin") {
        return null;
    }

    const { folder, nameSuffix } = getFolderAndNameSuffix(ctx, true);
    const buildDirectory = BuildFlags.buildDirectoryFromWorkspacePath(folder, true);
    // On macOS, find the path to xctest
    // and point it at the .xctest bundle from the configured build directory.
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
    const sanitizer = ctx.workspaceContext.toolchain.sanitizer(configuration.sanitizer);
    const envCommands = Object.entries({
        ...swiftRuntimeEnv(),
        ...configuration.folder(ctx.workspaceFolder).testEnvironmentVariables,
        ...sanitizer?.runtimeEnvironment,
    }).map(([key, value]) => `settings set target.env-vars ${key}="${value}"`);

    return {
        type: DebugAdapter.adapterName,
        request: "custom",
        sourceLanguages: ["swift"],
        name: `Test ${ctx.swiftPackage.name}`,
        targetCreateCommands: [`file -a ${arch} ${xctestPath}/xctest`],
        processCreateCommands: [
            ...envCommands,
            `process launch -w ${folder} -- ${args} ${buildDirectory}/debug/${ctx.swiftPackage.name}PackageTests.xctest`,
        ],
        preLaunchTask: `swift: Build All${nameSuffix}`,
    };
}

/**
 * Run debugger for given configuration
 * @param config Debug configuration
 * @param workspaceFolder Workspace to run debugger in
 */
export async function debugLaunchConfig(
    workspaceFolder: vscode.WorkspaceFolder,
    config: vscode.DebugConfiguration,
    options: vscode.DebugSessionOptions = {}
) {
    return new Promise<void>((resolve, reject) => {
        vscode.debug.startDebugging(workspaceFolder, config, options).then(
            started => {
                if (started) {
                    const terminateSession = vscode.debug.onDidTerminateDebugSession(async () => {
                        // dispose terminate debug handler
                        terminateSession.dispose();
                        resolve();
                    });
                }
            },
            reason => {
                reject(reason);
            }
        );
    });
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

function getFolderAndNameSuffix(
    ctx: FolderContext,
    expandEnvVariables = false
): { folder: string; nameSuffix: string } {
    const workspaceFolder = expandEnvVariables
        ? ctx.workspaceFolder.uri.fsPath
        : `\${workspaceFolder:${ctx.workspaceFolder.name}}`;
    let folder: string;
    let nameSuffix: string;
    if (ctx.relativePath.length === 0) {
        folder = workspaceFolder;
        nameSuffix = "";
    } else {
        folder = `${workspaceFolder}/${ctx.relativePath}`;
        nameSuffix = ` (${ctx.relativePath})`;
    }
    return { folder: folder, nameSuffix: nameSuffix };
}
