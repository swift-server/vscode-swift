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

import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import configuration from "./configuration";
import { FolderEvent, WorkspaceContext } from "./WorkspaceContext";
import { createSwiftTask, SwiftTaskProvider } from "./SwiftTaskProvider";
import { FolderContext } from "./FolderContext";
import { PackageNode } from "./ui/PackageDependencyProvider";
import { withQuickPick } from "./ui/QuickPick";
import { execSwift, getErrorDescription } from "./utilities/utilities";
import { Version } from "./utilities/version";
import { DarwinCompatibleTarget, SwiftToolchain } from "./toolchain/toolchain";
import { debugSnippet, runSnippet } from "./SwiftSnippets";
import { debugLaunchConfig, getLaunchConfiguration } from "./debugger/launch";
import { execFile } from "./utilities/utilities";
import { MacroExpansionParams, macroExpansionRequest } from "./sourcekit-lsp/lspExtensions";

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
    const task = createSwiftTask(
        ["package", "resolve"],
        SwiftTaskProvider.resolvePackageName,
        {
            cwd: folderContext.folder,
            scope: folderContext.workspaceFolder,
            prefix: folderContext.name,
            presentationOptions: { reveal: vscode.TaskRevealKind.Silent },
        },
        folderContext.workspaceContext.toolchain
    );

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
    const task = createSwiftTask(
        ["package", "update"],
        SwiftTaskProvider.updatePackageName,
        {
            cwd: folderContext.folder,
            scope: folderContext.workspaceFolder,
            prefix: folderContext.name,
            presentationOptions: { reveal: vscode.TaskRevealKind.Silent },
        },
        folderContext.workspaceContext.toolchain
    );

    await executeTaskWithUI(task, "Updating Dependencies", folderContext).then(result => {
        updateAfterError(result, folderContext);
    });
}

/**
 * Executes a {@link vscode.Task task} to run swift target.
 */
export async function runBuild(ctx: WorkspaceContext) {
    await debugBuildWithOptions(ctx, { noDebug: true });
}

/**
 * Executes a {@link vscode.Task task} to debug swift target.
 */
export async function debugBuild(ctx: WorkspaceContext) {
    await debugBuildWithOptions(ctx, {});
}

/**
 * Executes a {@link vscode.Task task} to debug swift target.
 */
async function debugBuildWithOptions(ctx: WorkspaceContext, options: vscode.DebugSessionOptions) {
    const current = ctx.currentFolder;
    if (!current) {
        return;
    }
    const file = vscode.window.activeTextEditor?.document.fileName;
    if (!file) {
        return;
    }
    const target = current.swiftPackage.getTarget(file);
    if (!target || target.type !== "executable") {
        return;
    }
    const launchConfig = getLaunchConfiguration(target.name, current);
    if (launchConfig) {
        return debugLaunchConfig(current.workspaceFolder, launchConfig, options);
    }
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
    const task = createSwiftTask(
        ["package", "clean"],
        SwiftTaskProvider.cleanBuildName,
        {
            cwd: folderContext.folder,
            scope: folderContext.workspaceFolder,
            prefix: folderContext.name,
            presentationOptions: { reveal: vscode.TaskRevealKind.Silent },
            group: vscode.TaskGroup.Clean,
        },
        folderContext.workspaceContext.toolchain
    );

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
    const task = createSwiftTask(
        ["package", "reset"],
        "Reset Package Dependencies",
        {
            cwd: folderContext.folder,
            scope: folderContext.workspaceFolder,
            prefix: folderContext.name,
            presentationOptions: { reveal: vscode.TaskRevealKind.Silent },
            group: vscode.TaskGroup.Clean,
        },
        folderContext.workspaceContext.toolchain
    );

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
            },
            folderContext.workspaceContext.toolchain
        );

        await executeTaskWithUI(resolveTask, "Resolving Dependencies", folderContext);
    });
}

/**
 * Run single Swift file through Swift REPL
 */
async function runSwiftScript(ctx: WorkspaceContext) {
    const document = vscode.window.activeTextEditor?.document;
    if (!document) {
        return;
    }

    // Swift scripts require new swift driver to work on Windows. Swift driver is available
    // from v5.7 of Windows Swift
    if (
        process.platform === "win32" &&
        ctx.toolchain.swiftVersion.isLessThan(new Version(5, 7, 0))
    ) {
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

    const runTask = createSwiftTask(
        [filename],
        `Run ${filename}`,
        {
            scope: vscode.TaskScope.Global,
            cwd: vscode.Uri.file(path.dirname(filename)),
            presentationOptions: { reveal: vscode.TaskRevealKind.Always, clear: true },
        },
        ctx.toolchain
    );
    await ctx.tasks.executeTaskAndWait(runTask);

    // delete file after running swift
    if (isTempFile) {
        await fs.rm(filename);
    }
}

async function runPluginTask() {
    vscode.commands.executeCommand("workbench.action.tasks.runTask", {
        type: "swift-plugin",
    });
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
                },
                ctx.toolchain
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
    const task = createSwiftTask(
        ["package", "edit", identifier],
        "Edit Package Dependency",
        {
            scope: currentFolder.workspaceFolder,
            cwd: currentFolder.folder,
            prefix: currentFolder.name,
        },
        ctx.toolchain
    );
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
            ctx.toolchain,
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

function insertFunctionComment(workspaceContext: WorkspaceContext) {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        return;
    }
    const line = activeEditor.selection.active.line;
    workspaceContext.commentCompletionProvider.insert(activeEditor, line);
}

function expandMacro(workspaceContext: WorkspaceContext) {
    const activeEditor = vscode.window.activeTextEditor;
    const document = activeEditor?.document;
    const selection = activeEditor?.selection;
    if (!document || !selection) {
        return;
    }
    return workspaceContext.languageClientManager.useLanguageClient(async (client, token) => {
        const params: MacroExpansionParams = {
            textDocument: client.code2ProtocolConverter.asTextDocumentIdentifier(document),
            range: client.code2ProtocolConverter.asRange(selection),
        };
        const expansions = await client.sendRequest(macroExpansionRequest, params, token);
        if (expansions && expansions.length >= 1) {
            // Present the macro expansion using a custom in-memory URI scheme
            // TODO: This will currently reregister the provider for this scheme
            // every time a new macro expansion is requested. It looks like the
            // old expansions will be closed correctly, but perhaps there's
            // a more elegant solution to this?
            const scheme = "swift-macro-expansion";
            const provider = vscode.workspace.registerTextDocumentContentProvider(scheme, {
                provideTextDocumentContent: async uri => expansions[+uri.fragment].sourceText,
            });
            workspaceContext.subscriptions.push(provider);
            console.log(expansions);
            // TODO: Use a proper URI scheme. See the discussion in
            // https://github.com/apple/sourcekit-lsp/pull/892#discussion_r1358428808
            // Perhaps we'd even want to have the server support these URIs directly?
            const locations = expansions.map(
                (_, i) =>
                    new vscode.Location(
                        vscode.Uri.from({
                            scheme,
                            path: "Macro Expansion.swift",
                            fragment: `${i}`,
                        }),
                        new vscode.Position(0, 0)
                    )
            );
            // TODO: Find a better way to preview multiple expansions, perhaps
            // using a diff-style view showing the expandeed fragments within
            // the peek editor?
            await vscode.commands.executeCommand(
                "editor.action.peekLocations",
                document.uri,
                client.protocol2CodeConverter.asPosition(expansions[0].position),
                locations,
                "peek"
            );
        } else {
            vscode.window.showWarningMessage("Could not find a macro expansion.");
        }
    });
}

/** Restart the SourceKit-LSP server */
function restartLSPServer(workspaceContext: WorkspaceContext) {
    workspaceContext.languageClientManager.restart();
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

/**
 * Switches the target SDK to the platform selected in a QuickPick UI.
 */
async function switchPlatform() {
    await withQuickPick(
        "Select a new target",
        [
            { value: undefined, label: "macOS" },
            { value: DarwinCompatibleTarget.iOS, label: "iOS" },
            { value: DarwinCompatibleTarget.tvOS, label: "tvOS" },
            { value: DarwinCompatibleTarget.watchOS, label: "watchOS" },
        ],
        async picked => {
            const sdkForTarget = picked.value
                ? await SwiftToolchain.getSDKForTarget(picked.value)
                : "";
            if (sdkForTarget !== undefined) {
                if (sdkForTarget !== "") {
                    configuration.sdk = sdkForTarget;
                    vscode.window.showWarningMessage(
                        `Selecting the ${picked.label} SDK will provide code editing support, but compiling with this SDK will have undefined results.`
                    );
                } else {
                    configuration.sdk = undefined;
                }
            } else {
                vscode.window.showErrorMessage("Unable to obtain requested SDK path");
            }
        }
    );
}

/**
 * Choose DEVELOPER_DIR
 * @param workspaceContext
 */
async function selectXcodeDeveloperDir() {
    const defaultXcode = await SwiftToolchain.getXcodeDeveloperDir();
    const selectedXcode = configuration.swiftEnvironmentVariables.DEVELOPER_DIR;
    const xcodes = await SwiftToolchain.getXcodeInstalls();
    await withQuickPick(
        selectedXcode ?? defaultXcode,
        xcodes.map(xcode => {
            const developerDir = `${xcode}/Contents/Developer`;
            return {
                label: developerDir === defaultXcode ? `${xcode} (default)` : xcode,
                folder: developerDir === defaultXcode ? undefined : developerDir,
            };
        }),
        async selected => {
            let swiftEnv = configuration.swiftEnvironmentVariables;
            const previousDeveloperDir = swiftEnv.DEVELOPER_DIR ?? defaultXcode;
            if (selected.folder) {
                swiftEnv.DEVELOPER_DIR = selected.folder;
            } else if (swiftEnv.DEVELOPER_DIR) {
                // if DEVELOPER_DIR was set and the new folder is the default then
                // delete variable
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const { DEVELOPER_DIR, ...rest } = swiftEnv;
                swiftEnv = rest;
            }
            configuration.swiftEnvironmentVariables = swiftEnv;
            // if SDK is inside previous DEVELOPER_DIR then move to new DEVELOPER_DIR
            if (
                configuration.sdk.length > 0 &&
                configuration.sdk.startsWith(previousDeveloperDir)
            ) {
                configuration.sdk = configuration.sdk.replace(
                    previousDeveloperDir,
                    selected.folder ?? defaultXcode
                );
            }
            vscode.window
                .showInformationMessage(
                    "Changing the Xcode Developer Directory requires the project be reloaded.",
                    "Ok"
                )
                .then(() => {
                    vscode.commands.executeCommand("workbench.action.reloadWindow");
                });
        }
    );
}

export async function showTestCoverageReport(workspaceContext: WorkspaceContext) {
    // show test coverage report
    if (workspaceContext.currentFolder) {
        workspaceContext.testCoverageDocumentProvider.show(workspaceContext.currentFolder);
    }
}

function toggleTestCoverageDisplay(workspaceContext: WorkspaceContext) {
    workspaceContext.toggleTestCoverageDisplay();
}

async function attachDebugger(workspaceContext: WorkspaceContext) {
    // use LLDB to get list of processes
    const lldb = workspaceContext.toolchain.getToolchainExecutable("lldb");
    try {
        const { stdout } = await execFile(lldb, [
            "--batch",
            "--no-lldbinit",
            "--one-line",
            "platform process list --show-args --all-users",
        ]);
        const entries = stdout.split("\n");
        const processPickItems = entries.flatMap(line => {
            const match = /^(\d+)\s+\d+\s+\S+\s+\S+\s+(.+)$/.exec(line);
            if (match) {
                return [{ pid: parseInt(match[1]), label: `${match[1]}: ${match[2]}` }];
            } else {
                return [];
            }
        });
        await withQuickPick("Select Process", processPickItems, async selected => {
            const debugConfig: vscode.DebugConfiguration = {
                type: "swift-lldb",
                request: "attach",
                name: "Attach",
                pid: selected.pid,
            };
            await vscode.debug.startDebugging(undefined, debugConfig);
        });
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to run LLDB: ${getErrorDescription(error)}`);
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
        vscode.commands.registerCommand("swift.run", () => runBuild(ctx)),
        vscode.commands.registerCommand("swift.debug", () => debugBuild(ctx)),
        vscode.commands.registerCommand("swift.cleanBuild", () => cleanBuild(ctx)),
        // Note: This is only available on macOS (gated in `package.json`) because its the only OS that has the iOS SDK available.
        vscode.commands.registerCommand("swift.switchPlatform", () => switchPlatform()),
        vscode.commands.registerCommand("swift.resetPackage", () => resetPackage(ctx)),
        vscode.commands.registerCommand("swift.runScript", () => runSwiftScript(ctx)),
        vscode.commands.registerCommand("swift.openPackage", () => openPackage(ctx)),
        vscode.commands.registerCommand("swift.runSnippet", () => runSnippet(ctx)),
        vscode.commands.registerCommand("swift.debugSnippet", () => debugSnippet(ctx)),
        vscode.commands.registerCommand("swift.runPluginTask", () => runPluginTask()),
        vscode.commands.registerCommand("swift.restartLSPServer", () => restartLSPServer(ctx)),
        vscode.commands.registerCommand("swift.insertFunctionComment", () =>
            insertFunctionComment(ctx)
        ),
        vscode.commands.registerCommand("swift.expandMacro", () => {
            expandMacro(ctx);
        }),
        vscode.commands.registerCommand("swift.showTestCoverageReport", () =>
            showTestCoverageReport(ctx)
        ),
        vscode.commands.registerCommand("swift.toggleTestCoverage", () =>
            toggleTestCoverageDisplay(ctx)
        ),
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
        }),
        vscode.commands.registerCommand("swift.selectXcodeDeveloperDir", () =>
            selectXcodeDeveloperDir()
        ),
        vscode.commands.registerCommand("swift.attachDebugger", () => attachDebugger(ctx))
    );
}
