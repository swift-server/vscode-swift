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
import * as path from "path";
import { FolderContext } from "./FolderContext";
import { StatusItem } from "./ui/StatusItem";
import { SwiftOutputChannel } from "./ui/SwiftOutputChannel";
import {
    pathExists,
    isPathInsidePath,
    swiftLibraryPathKey,
    getErrorDescription,
} from "./utilities/utilities";
import { getLLDBLibPath } from "./debugger/lldb";
import { LanguageClientManager } from "./sourcekit-lsp/LanguageClientManager";
import { TemporaryFolder } from "./utilities/tempFolder";
import { SwiftToolchain } from "./toolchain/toolchain";
import { TaskManager } from "./TaskManager";
import { BackgroundCompilation } from "./BackgroundCompilation";
import { makeDebugConfigurations } from "./debugger/launch";
import configuration from "./configuration";
import contextKeys from "./contextKeys";
import { setSnippetContextKey } from "./SwiftSnippets";
import { TestCoverageReportProvider } from "./coverage/TestCoverageReport";
import { CommentCompletionProviders } from "./editor/CommentCompletion";
import { TestCoverageRenderer } from "./coverage/TestCoverageRenderer";
import { DebugAdapter } from "./debugger/debugAdapter";

/**
 * Context for whole workspace. Holds array of contexts for each workspace folder
 * and the ExtensionContext
 */
export class WorkspaceContext implements vscode.Disposable {
    public folders: FolderContext[] = [];
    public currentFolder: FolderContext | null | undefined;
    public currentDocument: vscode.Uri | null;
    public outputChannel: SwiftOutputChannel;
    public statusItem: StatusItem;
    public languageClientManager: LanguageClientManager;
    public tasks: TaskManager;
    public subscriptions: { dispose(): unknown }[];
    public testCoverageDocumentProvider: TestCoverageReportProvider;
    public commentCompletionProvider: CommentCompletionProviders;
    public testCoverageRenderer: TestCoverageRenderer;
    private lastFocusUri: vscode.Uri | undefined;
    private initialisationFinished = false;

    private constructor(
        public tempFolder: TemporaryFolder,
        public toolchain: SwiftToolchain
    ) {
        this.outputChannel = new SwiftOutputChannel();
        this.statusItem = new StatusItem();
        this.languageClientManager = new LanguageClientManager(this);
        this.outputChannel.log(this.toolchain.swiftVersionString);
        this.toolchain.logDiagnostics(this.outputChannel);
        this.tasks = new TaskManager(this);
        this.currentDocument = null;
        // test coverage document provider
        this.testCoverageDocumentProvider = new TestCoverageReportProvider(this);
        this.commentCompletionProvider = new CommentCompletionProviders();
        this.testCoverageRenderer = new TestCoverageRenderer(this);

        const onChangeConfig = vscode.workspace.onDidChangeConfiguration(async event => {
            // on toolchain config change, reload window
            if (event.affectsConfiguration("swift.path")) {
                vscode.window
                    .showInformationMessage(
                        "Changing the Swift path requires the project be reloaded.",
                        "Ok"
                    )
                    .then(selected => {
                        if (selected === "Ok") {
                            vscode.commands.executeCommand("workbench.action.reloadWindow");
                        }
                    });
            }
            // on sdk config change, restart sourcekit-lsp
            if (event.affectsConfiguration("swift.SDK")) {
                // FIXME: There is a bug stopping us from restarting SourceKit-LSP directly.
                // As long as it's fixed we won't need to reload on newer versions.
                vscode.window
                    .showInformationMessage(
                        "Changing the Swift SDK path requires the project be reloaded.",
                        "Ok"
                    )
                    .then(selected => {
                        if (selected === "Ok") {
                            vscode.commands.executeCommand("workbench.action.reloadWindow");
                        }
                    });
            }
            // on runtime path config change, regenerate launch.json
            if (event.affectsConfiguration("swift.runtimePath")) {
                if (!this.needToAutoGenerateLaunchConfig()) {
                    return;
                }
                vscode.window
                    .showInformationMessage(
                        `Launch configurations need to be updated after changing the Swift runtime path. Custom versions of environment variable '${swiftLibraryPathKey()}' may be overridden. Do you want to update?`,
                        "Update",
                        "Cancel"
                    )
                    .then(async selected => {
                        if (selected === "Update") {
                            this.folders.forEach(
                                async ctx => await makeDebugConfigurations(ctx, undefined, true)
                            );
                        }
                    });
            }
            // on change of swift build path, regenerate launch.json
            if (event.affectsConfiguration("swift.buildPath")) {
                if (!this.needToAutoGenerateLaunchConfig()) {
                    return;
                }
                vscode.window
                    .showInformationMessage(
                        `Launch configurations need to be updated after changing the Swift build path. Do you want to update?`,
                        "Update",
                        "Cancel"
                    )
                    .then(async selected => {
                        if (selected === "Update") {
                            this.folders.forEach(
                                async ctx => await makeDebugConfigurations(ctx, undefined, true)
                            );
                        }
                    });
            }
            // on change of swift debugger type
            if (
                event.affectsConfiguration("swift.debugger.useDebugAdapterFromToolchain") ||
                event.affectsConfiguration("swift.debugger.path")
            ) {
                if (configuration.debugger.useDebugAdapterFromToolchain) {
                    if (!(await DebugAdapter.verifyDebugAdapterExists(this))) {
                        return;
                    }
                }
                this.folders.forEach(
                    async ctx =>
                        await makeDebugConfigurations(
                            ctx,
                            "Launch configurations need to be updated after changing the debug adapter."
                        )
                );
            }
        });
        const backgroundCompilationOnDidSave = BackgroundCompilation.start(this);
        const contextKeysUpdate = this.observeFolders((folder, event) => {
            switch (event) {
                case FolderEvent.remove:
                    this.updatePluginContextKey();
                    break;
                case FolderEvent.focus:
                    this.updateContextKeys(folder);
                    this.updateContextKeysForFile();
                    break;
                case FolderEvent.unfocus:
                    this.updateContextKeys(folder);
                    break;
                case FolderEvent.resolvedUpdated:
                    if (folder === this.currentFolder) {
                        this.updateContextKeys(folder);
                    }
            }
        });
        // add end of task handler to be called whenever a build task has finished. If
        // it is the build task for this folder then focus on the problems view
        const onDidEndTask = this.tasks.onDidEndTaskProcess(event => {
            const task = event.execution.task;
            if (
                task.group === vscode.TaskGroup.Build &&
                event.exitCode !== 0 &&
                event.exitCode !== undefined &&
                configuration.actionAfterBuildError === "Focus Problems"
            ) {
                vscode.commands.executeCommand("workbench.panel.markers.view.focus");
            }
        });
        const swiftFileWatcher = vscode.workspace.createFileSystemWatcher("**/*.swift");
        swiftFileWatcher.onDidCreate(uri => {
            this.swiftFileObservers.forEach(observer => observer(uri, FileEvent.created));
        });
        swiftFileWatcher.onDidChange(uri => {
            this.swiftFileObservers.forEach(observer => observer(uri, FileEvent.changed));
        });
        swiftFileWatcher.onDidDelete(uri => {
            this.swiftFileObservers.forEach(observer => observer(uri, FileEvent.deleted));
        });

        this.subscriptions = [
            swiftFileWatcher,
            onDidEndTask,
            this.commentCompletionProvider,
            this.testCoverageDocumentProvider,
            this.testCoverageRenderer,
            backgroundCompilationOnDidSave,
            contextKeysUpdate,
            onChangeConfig,
            this.tasks,
            this.languageClientManager,
            this.outputChannel,
            this.statusItem,
        ];
        this.lastFocusUri = vscode.window.activeTextEditor?.document.uri;
    }

    dispose() {
        this.folders.forEach(f => f.dispose());
        this.subscriptions.forEach(item => item.dispose());
    }

    get swiftVersion() {
        return this.toolchain.swiftVersion;
    }

    /** Get swift version and create WorkspaceContext */
    static async create(): Promise<WorkspaceContext> {
        const tempFolder = await TemporaryFolder.create();
        const toolchain = await SwiftToolchain.create();
        return new WorkspaceContext(tempFolder, toolchain);
    }

    /**
     * Update context keys based on package contents
     */
    updateContextKeys(folderContext: FolderContext | null) {
        if (!folderContext || !folderContext.swiftPackage.foundPackage) {
            contextKeys.hasPackage = false;
            contextKeys.packageHasDependencies = false;
            return;
        }
        contextKeys.hasPackage = true;
        contextKeys.packageHasDependencies = folderContext.swiftPackage.dependencies.length > 0;
    }

    /**
     * Update context keys based on package contents
     */
    updateContextKeysForFile() {
        if (this.currentDocument) {
            contextKeys.currentTargetType = this.currentFolder?.swiftPackage.getTarget(
                this.currentDocument?.fsPath
            )?.type;
        } else {
            contextKeys.currentTargetType = undefined;
        }
        setSnippetContextKey(this);
    }

    /**
     * Update hasPlugins context key
     */
    updatePluginContextKey() {
        let hasPlugins = false;
        for (const folder of this.folders) {
            if (folder.swiftPackage.plugins.length > 0) {
                hasPlugins = true;
                break;
            }
        }
        contextKeys.packageHasPlugins = hasPlugins;
    }

    /** Setup the vscode event listeners to catch folder changes and active window changes */
    setupEventListeners() {
        // add event listener for when a workspace folder is added/removed
        const onWorkspaceChange = vscode.workspace.onDidChangeWorkspaceFolders(event => {
            if (this === undefined) {
                console.log("Trying to run onDidChangeWorkspaceFolders on deleted context");
                return;
            }
            this.onDidChangeWorkspaceFolders(event);
        });
        // add event listener for when the active edited text document changes
        const onDidChangeActiveWindow = vscode.window.onDidChangeActiveTextEditor(async editor => {
            if (this === undefined) {
                console.log("Trying to run onDidChangeWorkspaceFolders on deleted context");
                return;
            }
            await this.focusTextEditor(editor);
        });
        this.subscriptions.push(onWorkspaceChange, onDidChangeActiveWindow);
    }

    /** Add workspace folders at initialisation */
    async addWorkspaceFolders() {
        // add workspace folders, already loaded
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            for (const folder of vscode.workspace.workspaceFolders) {
                await this.addWorkspaceFolder(folder);
            }
        }
        // If we don't have a current selected folder Start up language server by firing focus event
        // on either null folder or the first folder if there is only one
        if (this.currentFolder === undefined) {
            if (this.folders.length === 1) {
                await this.focusFolder(this.folders[0]);
            } else {
                await this.focusFolder(null);
            }
        }
        this.initialisationComplete();
    }

    /**
     * Fire an event to all folder observers
     * @param folder folder to fire event for
     * @param event event type
     */
    async fireEvent(folder: FolderContext | null, event: FolderEvent) {
        for (const observer of this.observers) {
            await observer(folder, event, this);
        }
    }

    /**
     * set the focus folder
     * @param folder folder that has gained focus, you can have a null folder
     */
    async focusFolder(folderContext: FolderContext | null) {
        // null and undefined mean different things here. Undefined means nothing
        // has been setup, null means we want to send focus events but for a null
        // folder
        if (folderContext === this.currentFolder) {
            return;
        }

        // send unfocus event for previous folder observers
        if (this.currentFolder !== undefined) {
            await this.fireEvent(this.currentFolder, FolderEvent.unfocus);
        }
        this.currentFolder = folderContext;

        // send focus event to all observers
        await this.fireEvent(folderContext, FolderEvent.focus);
    }

    /**
     * catch workspace folder changes and add or remove folders based on those changes
     * @param event workspace folder event
     */
    async onDidChangeWorkspaceFolders(event: vscode.WorkspaceFoldersChangeEvent) {
        for (const folder of event.added) {
            await this.addWorkspaceFolder(folder);
        }

        for (const folder of event.removed) {
            await this.removeWorkspaceFolder(folder);
        }
    }

    /**
     * Called whenever a folder is added to the workspace
     * @param folder folder being added
     */
    async addWorkspaceFolder(workspaceFolder: vscode.WorkspaceFolder) {
        await this.searchForPackages(workspaceFolder.uri, workspaceFolder);

        if (this.getActiveWorkspaceFolder(vscode.window.activeTextEditor) === workspaceFolder) {
            await this.focusTextEditor(vscode.window.activeTextEditor);
        }
    }

    async searchForPackages(folder: vscode.Uri, workspaceFolder: vscode.WorkspaceFolder) {
        // add folder if Package.swift/compile_commands.json exists
        if (await this.isValidWorkspaceFolder(folder.fsPath)) {
            await this.addPackageFolder(folder, workspaceFolder);
            return;
        }
        // should I search sub-folders for more Swift Packages
        if (!configuration.folder(workspaceFolder).searchSubfoldersForPackages) {
            return;
        }

        await vscode.workspace.fs.readDirectory(folder).then(async entries => {
            for (const entry of entries) {
                if (
                    entry[1] === vscode.FileType.Directory &&
                    entry[0][0] !== "." &&
                    entry[0] !== "Packages"
                ) {
                    await this.searchForPackages(
                        vscode.Uri.joinPath(folder, entry[0]),
                        workspaceFolder
                    );
                }
            }
        });
    }

    public async addPackageFolder(
        folder: vscode.Uri,
        workspaceFolder: vscode.WorkspaceFolder
    ): Promise<FolderContext> {
        // find context with root folder
        const index = this.folders.findIndex(context => context.folder.fsPath === folder.fsPath);
        if (index !== -1) {
            console.error(`Adding package folder ${folder} twice`);
            return this.folders[index];
        }
        const folderContext = await FolderContext.create(folder, workspaceFolder, this);
        this.folders.push(folderContext);

        await this.fireEvent(folderContext, FolderEvent.add);

        return folderContext;
    }

    /**
     * called when a folder is removed from workspace
     * @param folder folder being removed
     */
    async removeWorkspaceFolder(workspaceFolder: vscode.WorkspaceFolder) {
        this.folders.forEach(async folder => {
            if (folder.workspaceFolder !== workspaceFolder) {
                return;
            }
            // if current folder is this folder send unfocus event by setting
            // current folder to undefined
            if (this.currentFolder === folder) {
                this.focusFolder(null);
            }
            // run observer functions in reverse order when removing
            const observersReversed = [...this.observers];
            observersReversed.reverse();
            for (const observer of observersReversed) {
                await observer(folder, FolderEvent.remove, this);
            }
            folder.dispose();
        });
        this.folders = this.folders.filter(folder => folder.workspaceFolder !== workspaceFolder);
    }

    /**
     * Add workspace folder event observer
     * @param fn observer function to be called when event occurs
     * @returns disposable object
     */
    observeFolders(fn: WorkspaceFoldersObserver): vscode.Disposable {
        this.observers.add(fn);
        return { dispose: () => this.observers.delete(fn) };
    }

    /**
     * Add swift file event observer
     * @param fn observer function to be called when event occurs
     * @returns disposable object
     */
    observeSwiftFiles(fn: SwiftFileObserver): vscode.Disposable {
        this.swiftFileObservers.add(fn);
        return { dispose: () => this.swiftFileObservers.delete(fn) };
    }

    /** find LLDB version and setup path in CodeLLDB */
    async setLLDBVersion() {
        // check we are using CodeLLDB
        if (DebugAdapter.adapterName !== "lldb") {
            return;
        }
        const libPathResult = await getLLDBLibPath(this.toolchain);
        if (!libPathResult.success) {
            // if failure message is undefined then fail silently
            if (!libPathResult.failure) {
                return;
            }
            const errorMessage = `Error: ${getErrorDescription(libPathResult.failure)}`;
            vscode.window.showErrorMessage(
                `Failed to setup CodeLLDB for debugging of Swift code. Debugging may produce unexpected results. ${errorMessage}`
            );
            this.outputChannel.log(`Failed to setup CodeLLDB: ${errorMessage}`);
            return;
        }

        const libPath = libPathResult.success;
        const lldbConfig = vscode.workspace.getConfiguration("lldb");
        const configLLDBPath = lldbConfig.get<string>("library");
        const expressions = lldbConfig.get<string>("launch.expressions");
        if (configLLDBPath === libPath && expressions === "native") {
            return;
        }

        // show dialog for setting up LLDB
        vscode.window
            .showInformationMessage(
                "The Swift extension needs to update some CodeLLDB settings to enable debugging features. Do you want to set this up in your global settings or the workspace settings?",
                "Global",
                "Workspace",
                "Cancel"
            )
            .then(result => {
                switch (result) {
                    case "Global":
                        lldbConfig.update("library", libPath, vscode.ConfigurationTarget.Global);
                        lldbConfig.update(
                            "launch.expressions",
                            "native",
                            vscode.ConfigurationTarget.Global
                        );
                        // clear workspace setting
                        lldbConfig.update(
                            "library",
                            undefined,
                            vscode.ConfigurationTarget.Workspace
                        );
                        // clear workspace setting
                        lldbConfig.update(
                            "launch.expressions",
                            undefined,
                            vscode.ConfigurationTarget.Workspace
                        );
                        break;
                    case "Workspace":
                        lldbConfig.update("library", libPath, vscode.ConfigurationTarget.Workspace);
                        lldbConfig.update(
                            "launch.expressions",
                            "native",
                            vscode.ConfigurationTarget.Workspace
                        );
                        break;
                }
            });
    }

    /** set focus based on the file a TextEditor is editing */
    async focusTextEditor(editor?: vscode.TextEditor) {
        await this.focusUri(editor?.document.uri);
    }

    async focusUri(uri?: vscode.Uri) {
        this.currentDocument = uri ?? null;
        this.updateContextKeysForFile();
        if (this.currentDocument?.scheme === "file") {
            await this.focusPackageUri(this.currentDocument);
        }
    }

    /** set focus based on the file */
    async focusPackageUri(uri: vscode.Uri) {
        const packageFolder = await this.getPackageFolder(uri);
        if (packageFolder instanceof FolderContext) {
            await this.focusFolder(packageFolder);
            // clear last focus uri as we have set focus for a folder that has already loaded
            this.lastFocusUri = undefined;
        } else if (packageFolder instanceof vscode.Uri) {
            if (this.initialisationFinished === false) {
                // If a package takes a long time to load during initialisation, a focus event
                // can occur prior to the package being fully loaded. At this point because the
                // folder for that package isn't setup it will attempt to add the package again.
                // To avoid this if we are still initialising we store the last uri to get focus
                // and once the initialisation is complete we call focusUri again from the function
                // initialisationComplete.
                this.lastFocusUri = uri;
            } else {
                const workspaceFolder = vscode.workspace.getWorkspaceFolder(packageFolder);
                if (!workspaceFolder) {
                    return;
                }
                await this.unfocusCurrentFolder();
                const folderContext = await this.addPackageFolder(packageFolder, workspaceFolder);
                await this.focusFolder(folderContext);
            }
        } else {
            await this.focusFolder(null);
        }
    }

    public toggleTestCoverageDisplay() {
        if (!this.testCoverageRenderer) {
            this.testCoverageRenderer = new TestCoverageRenderer(this);
            this.subscriptions.push(this.testCoverageRenderer);
        }
        this.testCoverageRenderer.toggleDisplayResults();
    }

    private initialisationComplete() {
        this.initialisationFinished = true;
        if (this.lastFocusUri) {
            this.focusUri(this.lastFocusUri);
            this.lastFocusUri = undefined;
        }
    }

    /** return workspace folder from text editor */
    private getWorkspaceFolder(url: vscode.Uri): vscode.WorkspaceFolder | undefined {
        return vscode.workspace.getWorkspaceFolder(url);
    }

    /** return workspace folder from text editor */
    private getActiveWorkspaceFolder(
        editor?: vscode.TextEditor
    ): vscode.WorkspaceFolder | undefined {
        if (!editor || !editor.document) {
            return;
        }
        return vscode.workspace.getWorkspaceFolder(editor.document.uri);
    }

    /** Return Package folder for url.
     *
     * First the functions checks in the currently loaded folders to see if it exists inside
     * one of those. If not then it searches up the tree to find the uppermost folder in the
     * workspace that contains a Package.swift
     */
    private async getPackageFolder(
        url: vscode.Uri
    ): Promise<FolderContext | vscode.Uri | undefined> {
        // is editor document in any of the current FolderContexts
        const folder = this.folders.find(context => {
            return isPathInsidePath(url.fsPath, context.folder.fsPath);
        });
        if (folder) {
            return folder;
        }

        // if not search directory tree for 'Package.swift' files
        const workspaceFolder = this.getWorkspaceFolder(url);
        if (!workspaceFolder) {
            return;
        }
        const workspacePath = workspaceFolder.uri.fsPath;
        let packagePath: string | undefined = undefined;
        let currentFolder = path.dirname(url.fsPath);
        // does Package.swift exist in this folder
        if (await this.isValidWorkspaceFolder(currentFolder)) {
            packagePath = currentFolder;
        }
        // does Package.swift exist in any parent folders up to the root of the
        // workspace
        while (currentFolder !== workspacePath) {
            currentFolder = path.dirname(currentFolder);
            if (await this.isValidWorkspaceFolder(currentFolder)) {
                packagePath = currentFolder;
            }
        }

        if (packagePath) {
            return vscode.Uri.file(packagePath);
        } else {
            return;
        }
    }

    /**
     * Return if folder is considered a valid root folder ie does it contain a SwiftPM
     * Package.swift or a CMake compile_commands.json
     */
    async isValidWorkspaceFolder(folder: string): Promise<boolean> {
        return (
            ((await pathExists(folder, "Package.swift")) &&
                !configuration.disableSwiftPMIntegration) ||
            (await pathExists(folder, "compile_commands.json"))
        );
    }

    /** send unfocus event to current focussed folder and clear current folder */
    private async unfocusCurrentFolder() {
        // send unfocus event for previous folder observers
        if (this.currentFolder !== undefined) {
            await this.fireEvent(this.currentFolder, FolderEvent.unfocus);
        }
        this.currentFolder = undefined;
    }

    private needToAutoGenerateLaunchConfig() {
        let autoGenerate = false;
        this.folders.forEach(folder => {
            const requiresAutoGenerate =
                configuration.folder(folder.workspaceFolder).autoGenerateLaunchConfigurations &&
                folder.swiftPackage.executableProducts.length > 0;
            autoGenerate = autoGenerate || requiresAutoGenerate;
        });
        return autoGenerate;
    }

    private observers: Set<WorkspaceFoldersObserver> = new Set();
    private swiftFileObservers: Set<SwiftFileObserver> = new Set();
}

/** Workspace Folder events */
export enum FolderEvent {
    // Package folder has been added
    add = "add",
    // Package folder has been removed
    remove = "remove",
    // Workspace folder has gained focus via a file inside the folder becoming the actively edited file
    focus = "focus",
    // Workspace folder loses focus because another workspace folder gained it
    unfocus = "unfocus",
    // Package.swift has been updated
    packageUpdated = "packageUpdated",
    // Package.resolved has been updated
    resolvedUpdated = "resolvedUpdated",
}

/** Workspace Folder observer function */
export type WorkspaceFoldersObserver = (
    folder: FolderContext | null,
    operation: FolderEvent,
    workspace: WorkspaceContext
) => unknown;

/** File events */
export enum FileEvent {
    // File has been created
    created = "created",
    // File has been changed
    changed = "changed",
    // File was deleted
    deleted = "deleted",
}

/** Swift File observer function */
export type SwiftFileObserver = (uri: vscode.Uri, event: FileEvent) => unknown;
