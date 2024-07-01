//===----------------------------------------------------------------------===//
//
// This source file is part of the VS Code Swift open source project
//
// Copyright (c) 2024 the VS Code Swift project authors
// Licensed under Apache License v2.0
//
// See LICENSE.txt for license information
// See CONTRIBUTORS.txt for the list of VS Code Swift project authors
//
// SPDX-License-Identifier: Apache-2.0
//
//===----------------------------------------------------------------------===//

import * as vscode from "vscode";
import * as path from "path";
import { showReloadExtensionNotification } from "./ReloadExtension";
import { SwiftToolchain } from "../toolchain/toolchain";
import configuration from "../configuration";

/**
 * Open the installation page on Swift.org
 */
export async function downloadToolchain() {
    if (await vscode.env.openExternal(vscode.Uri.parse("https://www.swift.org/install"))) {
        const selected = await showReloadExtensionNotification(
            "The Swift extension must be reloaded once you have downloaded and installed the new toolchain.",
            "Select Toolchain"
        );
        if (selected === "Select Toolchain") {
            await vscode.commands.executeCommand("swift.selectToolchain");
        }
    }
}

/**
 * Open the installation page for Swiftly
 */
export async function installSwiftly() {
    if (await vscode.env.openExternal(vscode.Uri.parse("https://swiftlang.github.io/swiftly"))) {
        const selected = await showReloadExtensionNotification(
            "The Swift extension must be reloaded once you have downloaded and installed the new toolchain.",
            "Select Toolchain"
        );
        if (selected === "Select Toolchain") {
            await vscode.commands.executeCommand("swift.selectToolchain");
        }
    }
}

/**
 * Prompt the user to select a folder where they have installed the swift toolchain.
 * Updates the swift.path configuration with the selected folder.
 */
export async function selectToolchainFolder() {
    const selected = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: "Select the folder containing Swift binaries",
        openLabel: "Select folder",
    });
    if (!selected || selected.length !== 1) {
        return;
    }
    await setToolchainPath(selected[0].fsPath, "prompt");
}

/**
 * Displays an error notification to the user that toolchain discovery failed.
 */
export async function showToolchainError(): Promise<void> {
    let selected: "Remove From Settings" | "Select Toolchain" | undefined;
    if (configuration.path) {
        selected = await vscode.window.showErrorMessage(
            `The Swift executable at "${configuration.path}" either could not be found or failed to launch. Please select a new toolchain.`,
            "Remove From Settings",
            "Select Toolchain"
        );
    } else {
        selected = await vscode.window.showErrorMessage(
            "Unable to automatically discover your Swift toolchain. Either install a toolchain from Swift.org or provide the path to an existing toolchain.",
            "Select Toolchain"
        );
    }

    if (selected === "Remove From Settings") {
        await removeToolchainPath();
    } else if (selected === "Select Toolchain") {
        await vscode.commands.executeCommand("swift.selectToolchain");
    }
}

/** A {@link vscode.QuickPickItem} that contains the path to an installed swift toolchain */
interface SwiftToolchainItem extends vscode.QuickPickItem {
    type: "toolchain";
    toolchainPath: string;
    swiftFolderPath: string;
    onDidSelect?(): Promise<void>;
}

/** A {@link vscode.QuickPickItem} that performs an action for the user */
interface ActionItem extends vscode.QuickPickItem {
    type: "action";
    run(): Promise<void>;
}

/** A {@link vscode.QuickPickItem} that separates items in the UI */
class SeparatorItem implements vscode.QuickPickItem {
    readonly type = "separator";
    readonly kind = vscode.QuickPickItemKind.Separator;
    readonly label: string;

    constructor(label: string) {
        this.label = label;
    }
}

/** The possible types of {@link vscode.QuickPickItem} in the toolchain selection dialog */
type SelectToolchainItem = SwiftToolchainItem | ActionItem | SeparatorItem;

/**
 * Retrieves all {@link SelectToolchainItem} that are available on the system.
 *
 * @param ctx the {@link WorkspaceContext}
 * @returns an array of {@link SelectToolchainItem}
 */
async function getQuickPickItems(
    activeToolchain: SwiftToolchain | undefined
): Promise<SelectToolchainItem[]> {
    const xcodes = (await SwiftToolchain.getXcodeInstalls())
        .reverse()
        .map<SwiftToolchainItem>(xcodePath => {
            const toolchainPath = path.join(
                xcodePath,
                "Contents",
                "Developer",
                "Toolchains",
                "XcodeDefault.xctoolchain",
                "usr"
            );
            return {
                type: "toolchain",
                label: path.basename(xcodePath, ".app"),
                detail: xcodePath,
                toolchainPath,
                swiftFolderPath: path.join(toolchainPath, "bin"),
            };
        });
    const toolchains = (await SwiftToolchain.getToolchainInstalls())
        .reverse()
        .map<SwiftToolchainItem>(toolchainPath => {
            const result: SwiftToolchainItem = {
                type: "toolchain",
                label: path.basename(toolchainPath, ".xctoolchain"),
                detail: toolchainPath,
                toolchainPath: path.join(toolchainPath, "usr"),
                swiftFolderPath: path.join(toolchainPath, "usr", "bin"),
            };
            if (result.label === "swift-latest") {
                result.label = "Latest Installed Toolchain";
                result.onDidSelect = async () => {
                    vscode.window.showInformationMessage(
                        `The Swift extension is now configured to always use the most recently installed toolchain pointed at by the symbolic link "${toolchainPath}".`
                    );
                };
            }
            return result;
        });
    const swiftlyToolchains = (await SwiftToolchain.getSwiftlyToolchainInstalls())
        .reverse()
        .map<SwiftToolchainItem>(toolchainPath => ({
            type: "toolchain",
            label: path.basename(toolchainPath),
            detail: toolchainPath,
            toolchainPath: path.join(toolchainPath, "usr"),
            swiftFolderPath: path.join(toolchainPath, "usr", "bin"),
        }));
    if (activeToolchain) {
        const toolchainInUse = [...xcodes, ...toolchains, ...swiftlyToolchains].find(toolchain => {
            return toolchain.toolchainPath === activeToolchain.toolchainPath;
        });
        if (toolchainInUse) {
            toolchainInUse.description = "$(check) in use";
        } else {
            toolchains.splice(0, 0, {
                type: "toolchain",
                label: `Swift ${activeToolchain.swiftVersion.toString()}`,
                description: "$(check) in use",
                detail: activeToolchain.toolchainPath,
                toolchainPath: activeToolchain.toolchainPath,
                swiftFolderPath: activeToolchain.swiftFolderPath,
            });
        }
    }
    const actionItems: ActionItem[] = [];
    if (process.platform === "linux") {
        actionItems.push({
            type: "action",
            label: "$(swift-icon) Install Swiftly for toolchain management...",
            detail: "Install https://swiftlang.github.io/swiftly to manage your toolchains on Linux",
            run: installSwiftly,
        });
    }
    actionItems.push({
        type: "action",
        label: "$(cloud-download) Download from Swift.org...",
        detail: "Open https://swift.org/install to download and install a toolchain",
        run: downloadToolchain,
    });
    actionItems.push({
        type: "action",
        label: "$(folder-opened) Select toolchain directory...",
        detail: "Select a folder on your machine where the Swift toolchain is installed",
        run: selectToolchainFolder,
    });
    return [
        ...(xcodes.length > 0 ? [new SeparatorItem("Xcode"), ...xcodes] : []),
        ...(toolchains.length > 0 ? [new SeparatorItem("toolchains"), ...toolchains] : []),
        ...(swiftlyToolchains.length > 0
            ? [new SeparatorItem("swiftly"), ...swiftlyToolchains]
            : []),
        new SeparatorItem("actions"),
        ...actionItems,
    ];
}

/**
 * Prompt the user to select or install a swift toolchain. Updates the swift.path configuration
 * with the user's selection.
 *
 * @param activeToolchain the {@link WorkspaceContext}
 */
export async function showToolchainSelectionQuickPick(activeToolchain: SwiftToolchain | undefined) {
    const selected = await vscode.window.showQuickPick<SelectToolchainItem>(
        getQuickPickItems(activeToolchain),
        {
            title: "Select the Swift toolchain",
            placeHolder: "Pick a Swift toolchain that VS Code will use",
            canPickMany: false,
        }
    );
    if (selected?.type === "action") {
        await selected.run();
    } else if (selected?.type === "toolchain") {
        const isUpdated = await setToolchainPath(selected.swiftFolderPath, "prompt");
        if (isUpdated && selected.onDidSelect) {
            await selected.onDidSelect();
        }
    }
}

/**
 * Delete all set Swift path settings.
 */
async function removeToolchainPath() {
    const swiftSettings = vscode.workspace.getConfiguration("swift");
    await swiftSettings.update("path", undefined, vscode.ConfigurationTarget.Global);
    await swiftSettings.update("path", undefined, vscode.ConfigurationTarget.Workspace);
}

async function setToolchainPath(
    value: string | undefined,
    target?: vscode.ConfigurationTarget | "prompt"
): Promise<boolean> {
    if (target === "prompt") {
        const items: (vscode.QuickPickItem & {
            target?: vscode.ConfigurationTarget;
        })[] = [];
        if (vscode.workspace.workspaceFolders) {
            items.push({
                label: "Workspace Configuration",
                description: "(Recommended)",
                detail: "Add to VS Code workspace configuration",
                target: vscode.ConfigurationTarget.Workspace,
            });
        }
        items.push({
            label: "User Configuration",
            detail: "Add to VS Code user configuration.",
            target: vscode.ConfigurationTarget.Global,
        });
        if (items.length > 1) {
            const selected = await vscode.window.showQuickPick(items, {
                title: "Toolchain Configuration",
                placeHolder: "Select a location to update the toolchain selection",
                canPickMany: false,
            });
            if (!selected) {
                return false;
            }
            target = selected.target;
        } else {
            target = vscode.ConfigurationTarget.Global; // Global scope by default
        }
    }
    await vscode.workspace.getConfiguration("swift").update("path", value, target);
    await checkAndRemoveWorkspaceSetting(target);
    return true;
}

async function checkAndRemoveWorkspaceSetting(target: vscode.ConfigurationTarget | undefined) {
    // Check to see if the configuration would be overridden by workspace settings
    if (target !== vscode.ConfigurationTarget.Global) {
        return;
    }
    const inspect = vscode.workspace.getConfiguration("swift").inspect<string>("path");
    if (inspect?.workspaceValue) {
        const confirmation = await vscode.window.showWarningMessage(
            "You already have the Swift path configured in Workspace Settings which takes precedence over User Settings." +
                " Would you like to remove the setting from your workspace and use the User Settings instead?",
            "Remove Workspace Setting"
        );
        if (confirmation !== "Remove Workspace Setting") {
            return;
        }
        await vscode.workspace
            .getConfiguration("swift")
            .update("path", undefined, vscode.ConfigurationTarget.Workspace);
    }
}
