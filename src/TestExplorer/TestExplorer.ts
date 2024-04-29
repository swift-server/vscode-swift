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
import { FolderContext } from "../FolderContext";
import { getErrorDescription, isPathInsidePath } from "../utilities/utilities";
import { FolderEvent, WorkspaceContext } from "../WorkspaceContext";
import { TestRunner } from "./TestRunner";
import { LSPTestDiscovery } from "./LSPTestDiscovery";
import { Version } from "../utilities/version";
import configuration from "../configuration";
import { buildOptions, getBuildAllTask } from "../SwiftTaskProvider";
import { SwiftExecOperation, TaskOperation } from "../TaskQueue";
import * as TestDiscovery from "./TestDiscovery";
import { TargetType } from "../SwiftPackage";

/** Build test explorer UI */
export class TestExplorer {
    static errorTestItemId = "#Error#";
    public controller: vscode.TestController;
    private lspTestDiscovery: LSPTestDiscovery;
    private subscriptions: { dispose(): unknown }[];
    private testFileEdited = true;

    constructor(public folderContext: FolderContext) {
        this.controller = vscode.tests.createTestController(
            folderContext.name,
            `${folderContext.name} Tests`
        );

        this.controller.resolveHandler = async item => {
            if (!item) {
                await this.discoverTestsInWorkspace();
            } else {
                //
            }
        };

        TestRunner.setupProfiles(this.controller, this.folderContext);

        this.lspTestDiscovery = new LSPTestDiscovery(
            folderContext.workspaceContext.languageClientManager
        );

        // add end of task handler to be called whenever a build task has finished. If
        // it is the build task for this folder then update the tests
        const onDidEndTask = folderContext.workspaceContext.tasks.onDidEndTaskProcess(event => {
            const task = event.execution.task;
            const execution = task.execution as vscode.ProcessExecution;
            if (
                task.scope === this.folderContext.workspaceFolder &&
                task.group === vscode.TaskGroup.Build &&
                execution?.options?.cwd === this.folderContext.folder.fsPath &&
                event.exitCode === 0 &&
                task.definition.dontTriggerTestDiscovery !== true &&
                this.testFileEdited
            ) {
                this.testFileEdited = false;
                // only run discover tests if the library has tests
                if (this.folderContext.swiftPackage.getTargets(TargetType.test).length > 0) {
                    this.discoverTestsInWorkspace();
                }
            }
        });

        // add file watcher to catch changes to swift test files
        const fileWatcher = this.folderContext.workspaceContext.observeSwiftFiles(uri => {
            if (this.testFileEdited === false && this.folderContext.getTestTarget(uri)) {
                this.testFileEdited = true;
            }
        });
        this.subscriptions = [fileWatcher, onDidEndTask, this.controller];
    }

    dispose() {
        this.subscriptions.forEach(element => element.dispose());
    }

    /**
     * Create folder observer that creates a TestExplorer when a folder is added and
     * Discovers available tests when the folder is in focus
     * @param workspaceContext Workspace context for extension
     * @returns Observer disposable
     */
    static observeFolders(workspaceContext: WorkspaceContext): vscode.Disposable {
        return workspaceContext.observeFolders((folder, event, workspace) => {
            switch (event) {
                case FolderEvent.add:
                    if (folder) {
                        if (folder.swiftPackage.getTargets(TargetType.test).length > 0) {
                            folder.addTestExplorer();
                            // discover tests in workspace but only if disableAutoResolve is not on.
                            // discover tests will kick off a resolve if required
                            if (!configuration.folder(folder.workspaceFolder).disableAutoResolve) {
                                folder.testExplorer?.discoverTestsInWorkspace();
                            }
                        }
                    }
                    break;
                case FolderEvent.packageUpdated:
                    if (folder) {
                        const hasTestTargets =
                            folder.swiftPackage.getTargets(TargetType.test).length > 0;
                        if (hasTestTargets && !folder.hasTestExplorer()) {
                            folder.addTestExplorer();
                            // discover tests in workspace but only if disableAutoResolve is not on.
                            // discover tests will kick off a resolve if required
                            if (!configuration.folder(folder.workspaceFolder).disableAutoResolve) {
                                folder.testExplorer?.discoverTestsInWorkspace();
                            }
                        } else if (!hasTestTargets && folder.hasTestExplorer()) {
                            folder.removeTestExplorer();
                        }
                    }
                    break;
                case FolderEvent.focus:
                    if (folder) {
                        workspace.languageClientManager.documentSymbolWatcher = (
                            document,
                            symbols
                        ) => TestExplorer.onDocumentSymbols(folder, document, symbols);
                    }
            }
        });
    }

    /** Called whenever we have new document symbols */
    private static onDocumentSymbols(
        folder: FolderContext,
        document: vscode.TextDocument,
        symbols: vscode.DocumentSymbol[] | null | undefined
    ) {
        const uri = document?.uri;
        const testExplorer = folder?.testExplorer;
        if (testExplorer && symbols && uri && uri.scheme === "file") {
            if (isPathInsidePath(uri.fsPath, folder.folder.fsPath)) {
                const target = folder.swiftPackage.getTarget(uri.fsPath);
                if (target && target.type === "test") {
                    const tests = testExplorer.lspTestDiscovery.getTests(symbols, uri);
                    TestDiscovery.updateTests(
                        testExplorer.controller,
                        [
                            {
                                name: target.name,
                                folder: vscode.Uri.file(target.path),
                                classes: tests,
                            },
                        ],
                        uri
                    );
                }
            }
        }
    }

    /**
     * Discover tests
     */
    async discoverTestsInWorkspace() {
        //const toolchain = this.folderContext.workspaceContext.toolchain;
        //if (toolchain.swiftVersion.isLessThan(new Version(5, 11, 0))) {
        await this.discoverTestsInWorkspaceSPM();
        /*} else {
            try {
                await this.discoverTestsInWorkspaceLSP();
            } catch {
                await this.discoverTestsInWorkspaceSPM();
            }
        }*/
    }

    /**
     * Discover tests
     * Uses `swift test --list-tests` to get the list of tests
     */
    async discoverTestsInWorkspaceSPM() {
        try {
            const toolchain = this.folderContext.workspaceContext.toolchain;
            // get build options before build is run so we can be sure they aren't changed
            // mid-build
            const testBuildOptions = buildOptions(toolchain);
            // normally we wouldn't run the build here, but you can hang swiftPM on macOS
            // if you try and list tests while skipping the build if you are using a different
            // sanitizer settings
            if (process.platform === "darwin" && configuration.sanitizer !== "off") {
                const task = await getBuildAllTask(this.folderContext);
                task.definition.dontTriggerTestDiscovery = true;
                const exitCode = await this.folderContext.taskQueue.queueOperation(
                    new TaskOperation(task)
                );
                if (exitCode === undefined || exitCode !== 0) {
                    this.setErrorTestItem("Build the project to enable test discovery.");
                    return;
                }
            }
            // get list of tests from `swift test --list-tests`
            let listTestArguments: string[];
            if (toolchain.swiftVersion.isGreaterThanOrEqual(new Version(5, 8, 0))) {
                listTestArguments = ["test", "list", "--skip-build"];
            } else {
                listTestArguments = ["test", "--list-tests", "--skip-build"];
            }
            listTestArguments = [...listTestArguments, ...testBuildOptions];
            const listTestsOperation = new SwiftExecOperation(
                listTestArguments,
                this.folderContext,
                "Listing Tests",
                { showStatusItem: true, checkAlreadyRunning: false, log: "Listing tests" },
                stdout => {
                    // if we got to this point we can get rid of any error test item
                    this.deleteErrorTestItem();

                    const lines = stdout.match(/[^\r\n]+/g);
                    if (!lines) {
                        return;
                    }

                    // Build target array from test list output by `swift test list`
                    const targets = new Array<TestDiscovery.TestTarget>();
                    for (const line of lines) {
                        // Regex "<testTarget>.<class>/<function>"
                        const groups = /^([\w\d_]*)\.([\w\d_]*)\/(.*)$/.exec(line);
                        if (!groups) {
                            continue;
                        }
                        const targetName = groups[1];
                        const className = groups[2];
                        const funcName = groups[3];
                        let target = targets.find(item => item.name === targetName);
                        if (!target) {
                            target = { name: targetName, folder: undefined, classes: [] };
                            targets.push(target);
                        }
                        let testClass = target.classes.find(item => item.name === className);
                        if (!testClass) {
                            testClass = { name: className, location: undefined, functions: [] };
                            target.classes.push(testClass);
                        }
                        const testFunc = { name: funcName, location: undefined };
                        testClass.functions.push(testFunc);
                    }
                    // Update tests from target array
                    TestDiscovery.updateTests(this.controller, targets);
                }
            );
            await this.folderContext.taskQueue.queueOperation(listTestsOperation);
        } catch (error) {
            const errorDescription = getErrorDescription(error);
            if (
                (process.platform === "darwin" &&
                    errorDescription.match(/error: unableToLoadBundle/)) ||
                (process.platform === "win32" &&
                    errorDescription.match(/The file doesn’t exist./)) ||
                (!["darwin", "win32"].includes(process.platform) &&
                    errorDescription.match(/No such file or directory/))
            ) {
                this.setErrorTestItem("Build the project to enable test discovery.");
            } else if (errorDescription.startsWith("error: no tests found")) {
                this.setErrorTestItem("Add a test target to your Package.", "No Tests Found.");
            } else {
                this.setErrorTestItem(errorDescription);
            }
            this.folderContext.workspaceContext.outputChannel.log(
                `Test Discovery Failed: ${errorDescription}`,
                this.folderContext.name
            );
        }
    }

    /**
     * Discover tests
     */
    async discoverTestsInWorkspaceLSP() {
        const tests = await this.lspTestDiscovery.getWorkspaceTests(
            this.folderContext.workspaceFolder.uri
        );
        TestDiscovery.updateTestsFromClasses(this.folderContext, tests);
    }

    /** Delete TestItem with error id */
    private deleteErrorTestItem() {
        this.controller.items.delete(TestExplorer.errorTestItemId);
    }

    /**
     * Add/replace a TestItem with an error, if test controller currently has no TestItems
     * @param errorDescription Error description to display
     */
    private setErrorTestItem(errorDescription: string | undefined, title = "Test Discovery Error") {
        this.controller.items.forEach(item => {
            this.controller.items.delete(item.id);
        });
        if (this.controller.items.size === 0) {
            const errorItem = this.controller.createTestItem(TestExplorer.errorTestItemId, title);
            errorItem.error = errorDescription;
            this.controller.items.add(errorItem);
        }
    }
}
