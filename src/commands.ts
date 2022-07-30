//===----------------------------------------------------------------------===//
//
// This source file is part of the VSCode Swift open source project
//
// Copyright (c) 2021-2022 the VSCode Swift project authors
// Licensed under Apache License v2.0
//
// See LICENSE.txt for license information
// See CONTRIBUTORS.txt for the list of VSCode Swift project authors
//
// SPDX-License-Identifier: Apache-2.0
//
//===----------------------------------------------------------------------===//

import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { FolderEvent, WorkspaceContext } from "./WorkspaceContext";
import { createSwiftTask, SwiftTaskProvider } from "./SwiftTaskProvider";
import { FolderContext } from "./FolderContext";
import { PackageNode } from "./ui/PackageDependencyProvider";
import { execSwift } from "./utilities/utilities";
import { Version } from "./utilities/version";

/**
 * References:
 *
 * - Contributing commands:
 *   https://code.visualstudio.com/api/references/contribution-points#contributes.commands
 * - Implementing commands:
 *   https://code.visualstudio.com/api/extension-guides/command
 */

/**
 * Executes a {@link vscode.Task task} to resolve this package's dependencies.
 */
export async function resolveDependencies(ctx: WorkspaceContext) {
    const current = ctx.currentFolder;
    if (!current) {
        return;
    }
    await resolveFolderDependencies(current);
}

/**
 * Run `swift package resolve` inside a folder
 * @param folderContext folder to run resolve for
 */
export async function resolveFolderDependencies(
    folderContext: FolderContext,
    checkAlreadyRunning?: boolean
) {
    const task = createSwiftTask(["package", "resolve"], SwiftTaskProvider.resolvePackageName, {
        cwd: folderContext.folder,
        scope: folderContext.workspaceFolder,
        prefix: folderContext.name,
        presentationOptions: { reveal: vscode.TaskRevealKind.Silent },
    });

    await executeTaskWithUI(
        task,
        "Resolving Dependencies",
        folderContext,
        false,
        checkAlreadyRunning
    ).then(result => {
        updateAfterError(result, folderContext);
    });
}

/**
 * Executes a {@link vscode.Task task} to update this package's dependencies.
 */
export async function updateDependencies(ctx: WorkspaceContext) {
    const current = ctx.currentFolder;
    if (!current) {
        return;
    }
    await updateFolderDependencies(current);
}

/**
 * Run `swift package update` inside a folder
 * @param folderContext folder to run update inside
 * @returns
 */
export async function updateFolderDependencies(folderContext: FolderContext) {
    const task = createSwiftTask(["package", "update"], SwiftTaskProvider.updatePackageName, {
        cwd: folderContext.folder,
        scope: folderContext.workspaceFolder,
        prefix: folderContext.name,
        presentationOptions: { reveal: vscode.TaskRevealKind.Silent },
    });

    await executeTaskWithUI(task, "Updating Dependencies", folderContext).then(result => {
        updateAfterError(result, folderContext);
    });
}

/**
 * Executes a {@link vscode.Task task} to delete all build artifacts.
 */
export async function cleanBuild(ctx: WorkspaceContext) {
    const current = ctx.currentFolder;
    if (!current) {
        return;
    }
    await folderCleanBuild(current);
}

/**
 * Run `swift package clean` inside a folder
 * @param folderContext folder to run update inside
 */
export async function folderCleanBuild(folderContext: FolderContext) {
    const task = createSwiftTask(["package", "clean"], SwiftTaskProvider.cleanBuildName, {
        cwd: folderContext.folder,
        scope: folderContext.workspaceFolder,
        prefix: folderContext.name,
        presentationOptions: { reveal: vscode.TaskRevealKind.Silent },
        group: vscode.TaskGroup.Clean,
    });

    await executeTaskWithUI(task, "Clean Build", folderContext);
}

/**
 * Executes a {@link vscode.Task task} to reset the complete cache/build directory.
 */
export async function resetPackage(ctx: WorkspaceContext) {
    const current = ctx.currentFolder;
    if (!current) {
        return;
    }
    await folderResetPackage(current);
}

/**
 * Run `swift package reset` inside a folder
 * @param folderContext folder to run update inside
 */
export async function folderResetPackage(folderContext: FolderContext) {
    const task = createSwiftTask(["package", "reset"], "Reset Package Dependencies", {
        cwd: folderContext.folder,
        scope: folderContext.workspaceFolder,
        prefix: folderContext.name,
        presentationOptions: { reveal: vscode.TaskRevealKind.Silent },
        group: vscode.TaskGroup.Clean,
    });

    await executeTaskWithUI(task, "Reset Package", folderContext).then(async success => {
        if (!success) {
            return;
        }
        const resolveTask = createSwiftTask(
            ["package", "resolve"],
            SwiftTaskProvider.resolvePackageName,
            {
                cwd: folderContext.folder,
                scope: folderContext.workspaceFolder,
                prefix: folderContext.name,
                presentationOptions: { reveal: vscode.TaskRevealKind.Silent },
            }
        );

        await executeTaskWithUI(resolveTask, "Resolving Dependencies", folderContext);
    });
}

/**
 * Run single Swift file through Swift REPL
 */
async function runSingleFile(ctx: WorkspaceContext) {
    const document = vscode.window.activeTextEditor?.document;
    if (!document) {
        return;
    }

    // Swift scripts require new swift driver to work on Windows. Swift driver is available
    // from v5.7 of Windows Swift
    if (process.platform === "win32" && ctx.toolchain.swiftVersion < new Version(5, 7, 0)) {
        vscode.window.showErrorMessage(
            "Run Swift Script is unavailable with the legacy driver on Windows."
        );
        return;
    }

    let filename = document.fileName;
    let isTempFile = false;
    if (document.isUntitled) {
        // if document hasn't been saved, save it to a temporary file
        isTempFile = true;
        filename = ctx.tempFolder.filename(document.fileName, "swift");
        const text = document.getText();
        await fs.writeFile(filename, text);
    } else {
        // otherwise save document
        await document.save();
    }

    const runTask = createSwiftTask([filename], `Run ${filename}`, {
        scope: vscode.TaskScope.Global,
        cwd: vscode.Uri.file(path.dirname(filename)),
        presentationOptions: { reveal: vscode.TaskRevealKind.Always, clear: true },
    });
    await ctx.tasks.executeTaskAndWait(runTask);

    // delete file after running swift
    if (isTempFile) {
        await fs.rm(filename);
    }
}

/**
 * Use local version of package dependency
 *
 * equivalent of `swift package edit --path <localpath> identifier
 * @param identifier Identifier for dependency
 * @param ctx workspace context
 */
async function useLocalDependency(identifier: string, ctx: WorkspaceContext) {
    const currentFolder = ctx.currentFolder;
    if (!currentFolder) {
        return;
    }
    vscode.window
        .showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            defaultUri: currentFolder.folder,
            openLabel: "Select",
            title: "Select folder",
        })
        .then(async value => {
            if (!value) {
                return;
            }
            const folder = value[0];
            const task = createSwiftTask(
                ["package", "edit", "--path", folder.fsPath, identifier],
                "Edit Package Dependency",
                {
                    scope: currentFolder.workspaceFolder,
                    cwd: currentFolder.folder,
                    prefix: currentFolder.name,
                }
            );
            await executeTaskWithUI(
                task,
                `Use local version of ${identifier}`,
                currentFolder,
                true
            ).then(result => {
                if (result) {
                    ctx.fireEvent(currentFolder, FolderEvent.resolvedUpdated);
                }
            });
        });
}

/**
 * Setup package dependency to be edited
 * @param identifier Identifier of dependency we want to edit
 * @param ctx workspace context
 */
async function editDependency(identifier: string, ctx: WorkspaceContext) {
    const currentFolder = ctx.currentFolder;
    if (!currentFolder) {
        return;
    }
    const task = createSwiftTask(["package", "edit", identifier], "Edit Package Dependency", {
        scope: currentFolder.workspaceFolder,
        cwd: currentFolder.folder,
        prefix: currentFolder.name,
    });
    await executeTaskWithUI(task, `edit locally ${identifier}`, currentFolder, true).then(
        result => {
            if (result) {
                ctx.fireEvent(currentFolder, FolderEvent.resolvedUpdated);
                // add folder to workspace
                const index = vscode.workspace.workspaceFolders?.length ?? 0;
                vscode.workspace.updateWorkspaceFolders(index, 0, {
                    uri: vscode.Uri.file(currentFolder.editedPackageFolder(identifier)),
                    name: identifier,
                });
            }
        }
    );
}

/**
 * Stop local editing of package dependency
 * @param identifier Identifier of dependency
 * @param ctx workspace context
 */
async function uneditDependency(identifier: string, ctx: WorkspaceContext) {
    const currentFolder = ctx.currentFolder;
    if (!currentFolder) {
        return;
    }
    ctx.outputChannel.log(`unedit dependency ${identifier}`, currentFolder.name);
    const status = `Reverting edited dependency ${identifier} (${currentFolder.name})`;
    ctx.statusItem.start(status);
    await uneditFolderDependency(currentFolder, identifier, ctx);
    ctx.statusItem.end(status);
}

async function uneditFolderDependency(
    folder: FolderContext,
    identifier: string,
    ctx: WorkspaceContext,
    args: string[] = []
) {
    try {
        await execSwift(
            ["package", "unedit", ...args, identifier],
            {
                cwd: folder.folder.fsPath,
            },
            folder
        );
        ctx.fireEvent(folder, FolderEvent.resolvedUpdated);
        // find workspace folder, and check folder still exists
        const folderIndex = vscode.workspace.workspaceFolders?.findIndex(
            item => item.name === identifier
        );
        if (folderIndex) {
            try {
                // check folder exists. if error thrown remove folder
                await fs.stat(vscode.workspace.workspaceFolders![folderIndex].uri.fsPath);
            } catch {
                vscode.workspace.updateWorkspaceFolders(folderIndex, 1);
            }
        }
    } catch (error) {
        const execError = error as { stderr: string };
        // if error contains "has uncommited changes" then ask if user wants to force the unedit
        if (execError.stderr.match(/has uncommited changes/)) {
            vscode.window
                .showWarningMessage(
                    `${identifier} has uncommitted changes. Are you sure you want to continue?`,
                    "Yes",
                    "No"
                )
                .then(async result => {
                    if (result === "No") {
                        ctx.outputChannel.log(execError.stderr, folder.name);
                        return;
                    }
                    await uneditFolderDependency(folder, identifier, ctx, ["--force"]);
                });
        } else {
            ctx.outputChannel.log(execError.stderr, folder.name);
            vscode.window.showErrorMessage(`${execError.stderr}`);
        }
    }
}

/**
 * Open local package in workspace
 * @param packageNode PackageNode attached to dependency tree item
 */
async function openInWorkspace(packageNode: PackageNode) {
    const index = vscode.workspace.workspaceFolders?.length ?? 0;
    vscode.workspace.updateWorkspaceFolders(index, 0, {
        uri: vscode.Uri.file(packageNode.path),
        name: packageNode.name,
    });
}

/**
 * Open Package.swift for in focus project
 * @param workspaceContext Workspace context, required to get current project
 */
async function openPackage(workspaceContext: WorkspaceContext) {
    if (workspaceContext.currentFolder) {
        const packagePath = vscode.Uri.joinPath(
            workspaceContext.currentFolder.folder,
            "Package.swift"
        );
        const document = await vscode.workspace.openTextDocument(packagePath);
        vscode.window.showTextDocument(document);
    }
}

/** Execute task and show UI while running */
async function executeTaskWithUI(
    task: vscode.Task,
    description: string,
    folderContext: FolderContext,
    showErrors = false,
    checkAlreadyRunning?: boolean
): Promise<boolean> {
    try {
        const exitCode = await folderContext.taskQueue.queueOperation({
            task: task,
            showStatusItem: true,
            log: description,
            checkAlreadyRunning: checkAlreadyRunning,
        });
        if (exitCode === 0) {
            return true;
        } else {
            if (showErrors) {
                vscode.window.showErrorMessage(`${description} failed`);
            }
            return false;
        }
    } catch (error) {
        if (showErrors) {
            vscode.window.showErrorMessage(`${description} failed: ${error}`);
        }
        return false;
    }
}

/**
 *
 * @param packageNode PackageNode attached to dependency tree item
 */
function openInExternalEditor(packageNode: PackageNode) {
    try {
        const uri = vscode.Uri.parse(packageNode.location, true);
        vscode.env.openExternal(uri);
    } catch {
        // ignore error
    }
}

function updateAfterError(result: boolean, folderContext: FolderContext) {
    const triggerResolvedUpdatedEvent = folderContext.hasResolveErrors;
    // set has resolve errors flag
    folderContext.hasResolveErrors = !result;
    // if previous folder state was with resolve errors, and now it is without then
    // send Package.resolved updated event to trigger display of package dependencies
    // view
    if (triggerResolvedUpdatedEvent && !folderContext.hasResolveErrors) {
        folderContext.fireEvent(FolderEvent.resolvedUpdated);
    }
}

/**
 * Registers this extension's commands in the given {@link vscode.ExtensionContext context}.
 */
export function register(ctx: WorkspaceContext) {
    ctx.subscriptions.push(
        vscode.commands.registerCommand("swift.resolveDependencies", () =>
            resolveDependencies(ctx)
        ),
        vscode.commands.registerCommand("swift.updateDependencies", () => updateDependencies(ctx)),
        vscode.commands.registerCommand("swift.cleanBuild", () => cleanBuild(ctx)),
        vscode.commands.registerCommand("swift.resetPackage", () => resetPackage(ctx)),
        vscode.commands.registerCommand("swift.runSingle", () => runSingleFile(ctx)),
        vscode.commands.registerCommand("swift.openPackage", () => openPackage(ctx)),
        vscode.commands.registerCommand("swift.useLocalDependency", item => {
            if (item instanceof PackageNode) {
                useLocalDependency(item.name, ctx);
            }
        }),
        vscode.commands.registerCommand("swift.editDependency", item => {
            if (item instanceof PackageNode) {
                editDependency(item.name, ctx);
            }
        }),
        vscode.commands.registerCommand("swift.uneditDependency", item => {
            if (item instanceof PackageNode) {
                uneditDependency(item.name, ctx);
            }
        }),
        vscode.commands.registerCommand("swift.openInWorkspace", item => {
            if (item instanceof PackageNode) {
                openInWorkspace(item);
            }
        }),
        vscode.commands.registerCommand("swift.openExternal", item => {
            if (item instanceof PackageNode) {
                openInExternalEditor(item);
            }
        })
    );
}
