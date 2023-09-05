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
import * as commands from "./commands";
import * as debug from "./debugger/launch";
import { PackageDependenciesProvider } from "./ui/PackageDependencyProvider";
import { SwiftTaskProvider } from "./SwiftTaskProvider";
import { FolderEvent, WorkspaceContext } from "./WorkspaceContext";
import { FolderContext } from "./FolderContext";
import { TestExplorer } from "./TestExplorer/TestExplorer";
import { LanguageStatusItems } from "./ui/LanguageStatusItems";
import { getErrorDescription } from "./utilities/utilities";
import { SwiftPluginTaskProvider } from "./SwiftPluginTaskProvider";
import configuration from "./configuration";
import { Version } from "./utilities/version";
import { getReadOnlyDocumentProvider } from "./ui/ReadOnlyDocumentProvider";
import { registerLoggingDebugAdapterTracker } from "./debugger/logTracker";
import { registerLLDBDebugAdapter } from "./debugger/debugAdapterFactory";
import { DebugAdapter } from "./debugger/debugAdapter";

/**
 * External API as exposed by the extension. Can be queried by other extensions
 * or by the integration test runner for VSCode extensions.
 */
export interface Api {
    workspaceContext: WorkspaceContext;
}

/**
 * Activate the extension. This is the main entry point.
 */
export async function activate(context: vscode.ExtensionContext): Promise<Api> {
    try {
        console.debug("Activating Swift for Visual Studio Code...");

        const workspaceContext = await WorkspaceContext.create();

        context.subscriptions.push(workspaceContext);

        // setup swift version of LLDB. Don't await on this as it can run in the background
        await DebugAdapter.verifyDebugAdapterExists(workspaceContext, true);
        workspaceContext.setLLDBVersion();

        // listen for workspace folder changes and active text editor changes
        workspaceContext.setupEventListeners();

        // Register task provider.
        const taskProvider = vscode.tasks.registerTaskProvider(
            "swift",
            new SwiftTaskProvider(workspaceContext)
        );
        // Register swift plugin task provider.
        const pluginTaskProvider = vscode.tasks.registerTaskProvider(
            "swift-plugin",
            new SwiftPluginTaskProvider(workspaceContext)
        );
        commands.register(workspaceContext);

        const languageStatusItem = new LanguageStatusItems(workspaceContext);

        // swift module document provider
        const swiftModuleDocumentProvider = getReadOnlyDocumentProvider();

        // observer for logging workspace folder addition/removal
        const logObserver = workspaceContext.observeFolders((folderContext, event) => {
            workspaceContext.outputChannel.log(
                `${event}: ${folderContext?.folder.fsPath}`,
                folderContext?.name
            );
        });

        // dependency view
        const dependenciesProvider = new PackageDependenciesProvider(workspaceContext);
        const dependenciesView = vscode.window.createTreeView("packageDependencies", {
            treeDataProvider: dependenciesProvider,
            showCollapseAll: true,
        });
        dependenciesProvider.observeFolders(dependenciesView);

        // observer that will resolve package and build launch configurations
        const resolvePackageObserver = workspaceContext.observeFolders(
            async (folder, event, workspace) => {
                // function called when a folder is added. I broke this out so we can trigger it
                // without having to await for it.
                async function folderAdded(folder: FolderContext, workspace: WorkspaceContext) {
                    if (
                        !configuration.folder(folder.workspaceFolder).disableAutoResolve ||
                        configuration.backgroundCompilation
                    ) {
                        // if background compilation is set then run compile at startup unless
                        // this folder is a sub-folder of the workspace folder. This is to avoid
                        // kicking off compile for multiple projects at the same time
                        if (
                            configuration.backgroundCompilation &&
                            folder.workspaceFolder.uri === folder.folder
                        ) {
                            await folder.backgroundCompilation.runTask();
                        } else {
                            await commands.resolveFolderDependencies(folder, true);
                        }
                        if (workspace.swiftVersion.isGreaterThanOrEqual(new Version(5, 6, 0))) {
                            await workspace.statusItem.showStatusWhileRunning(
                                `Loading Swift Plugins (${FolderContext.uriName(
                                    folder.workspaceFolder.uri
                                )})`,
                                async () => {
                                    await folder.loadSwiftPlugins();
                                    workspace.updatePluginContextKey();
                                }
                            );
                        }
                    }
                }
                if (!folder) {
                    return;
                }
                switch (event) {
                    case FolderEvent.add:
                        // Create launch.json files based on package description.
                        debug.makeDebugConfigurations(folder);
                        if (folder.swiftPackage.foundPackage) {
                            // do not await for this, let packages resolve in parallel
                            folderAdded(folder, workspace);
                        }
                        break;

                    case FolderEvent.packageUpdated:
                        // Create launch.json files based on package description.
                        debug.makeDebugConfigurations(folder);
                        if (
                            folder.swiftPackage.foundPackage &&
                            !configuration.folder(folder.workspaceFolder).disableAutoResolve
                        ) {
                            await commands.resolveFolderDependencies(folder, true);
                        }
                        break;

                    case FolderEvent.resolvedUpdated:
                        if (
                            folder.swiftPackage.foundPackage &&
                            !configuration.folder(folder.workspaceFolder).disableAutoResolve
                        ) {
                            await commands.resolveFolderDependencies(folder, true);
                        }
                }
            }
        );

        const testExplorerObserver = TestExplorer.observeFolders(workspaceContext);

        if (configuration.debugger.useDebugAdapterFromToolchain) {
            const lldbDebugAdapter = registerLLDBDebugAdapter(workspaceContext);
            context.subscriptions.push(lldbDebugAdapter);
        }
        const loggingDebugAdapter = registerLoggingDebugAdapterTracker();

        // setup workspace context with initial workspace folders
        workspaceContext.addWorkspaceFolders();

        // Register any disposables for cleanup when the extension deactivates.
        context.subscriptions.push(
            loggingDebugAdapter,
            resolvePackageObserver,
            testExplorerObserver,
            swiftModuleDocumentProvider,
            dependenciesView,
            dependenciesProvider,
            logObserver,
            languageStatusItem,
            pluginTaskProvider,
            taskProvider
        );

        return { workspaceContext };
    } catch (error) {
        const errorMessage = getErrorDescription(error);
        // show this error message as the VSCode error message only shows when running
        // the extension through the debugger
        vscode.window.showErrorMessage(`Activating Swift extension failed: ${errorMessage}`);
        throw Error(errorMessage);
    }
}

/**
 * Deactivate the extension.
 *
 * Any disposables registered in `context.subscriptions` will be automatically
 * disposed of, so there's nothing left to do here.
 */
export function deactivate() {
    return;
}
