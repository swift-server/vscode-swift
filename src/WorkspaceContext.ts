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
    getSwiftExecutable,
    pathExists,
    isPathInsidePath,
    swiftLibraryPathKey,
} from "./utilities/utilities";
import { getLLDBLibPath } from "./debugger/lldb";
import { LanguageClientManager } from "./sourcekit-lsp/LanguageClientManager";
import { TemporaryFolder } from "./utilities/tempFolder";
import { SwiftToolchain } from "./toolchain/toolchain";
import { TaskManager } from "./TaskManager";
import { BackgroundCompilation } from "./BackgroundCompilation";
import { makeDebugConfigurations } from "./debugger/launch";
import configuration from "./configuration";

/**
 * Context for whole workspace. Holds array of contexts for each workspace folder
 * and the ExtensionContext
 */
export class WorkspaceContext implements vscode.Disposable {
    public folders: FolderContext[] = [];
    public currentFolder: FolderContext | null | undefined;
    public outputChannel: SwiftOutputChannel;
    public statusItem: StatusItem;
    public languageClientManager: LanguageClientManager;
    public tasks: TaskManager;
    public subscriptions: { dispose(): unknown }[];

    private constructor(public tempFolder: TemporaryFolder, public toolchain: SwiftToolchain) {
        this.outputChannel = new SwiftOutputChannel();
        this.statusItem = new StatusItem();
        this.languageClientManager = new LanguageClientManager(this);
        this.outputChannel.log(this.toolchain.swiftVersionString);
        this.toolchain.logDiagnostics(this.outputChannel);
        this.tasks = new TaskManager();
        const onChangeConfig = vscode.workspace.onDidChangeConfiguration(event => {
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
            // on runtime path config change, regenerate launch.json
            if (event.affectsConfiguration("swift.runtimePath")) {
                if (!configuration.autoGenerateLaunchConfigurations) {
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
                                async ctx => await makeDebugConfigurations(ctx, true)
                            );
                        }
                    });
            }
            // on destination config change, restart sourcekit-lsp
            if (event.affectsConfiguration("swift.destination.SDK")) {
                // FIXME: There is a bug stopping us from restarting SourceKit-LSP directly.
                // As long as it's fixed we won't need to reload on newer versions.
                vscode.window
                    .showInformationMessage(
                        "Changing the destination SDK path requires the project be reloaded.",
                        "Ok"
                    )
                    .then(selected => {
                        if (selected === "Ok") {
                            vscode.commands.executeCommand("workbench.action.reloadWindow");
                        }
                    });
            }
        });
        const backgroundCompilationOnDidSave = BackgroundCompilation.start(this);
        this.subscriptions = [
            backgroundCompilationOnDidSave,
            onChangeConfig,
            this.tasks,
            this.languageClientManager,
            this.outputChannel,
            this.statusItem,
        ];
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
                await this.fireEvent(this.folders[0], FolderEvent.focus);
            } else {
                await this.fireEvent(null, FolderEvent.focus);
            }
        }
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
            await this.removeFolder(folder);
        }
    }

    /**
     * Called whenever a folder is added to the workspace
     * @param folder folder being added
     */
    async addWorkspaceFolder(folder: vscode.WorkspaceFolder) {
        // add folder if Package.swift exists
        if (await pathExists(folder.uri.fsPath, "Package.swift")) {
            await this.addPackageFolder(folder.uri, folder);
        }

        if (this.getActiveWorkspaceFolder(vscode.window.activeTextEditor) === folder) {
            await this.focusTextEditor(vscode.window.activeTextEditor);
        }
    }

    async addPackageFolder(
        folder: vscode.Uri,
        workspaceFolder: vscode.WorkspaceFolder
    ): Promise<FolderContext> {
        const folderContext = await FolderContext.create(folder, workspaceFolder, this);
        this.folders.push(folderContext);

        await this.fireEvent(folderContext, FolderEvent.add);

        return folderContext;
    }

    /**
     * called when a folder is removed from workspace
     * @param folder folder being removed
     */
    async removeFolder(folder: vscode.WorkspaceFolder) {
        // find context with root folder
        const index = this.folders.findIndex(context => context.workspaceFolder === folder);
        if (index === -1) {
            console.error(`Trying to delete folder ${folder} which has no record`);
            return;
        }
        const context = this.folders[index];
        // if current folder is this folder send unfocus event by setting
        // current folder to undefined
        if (this.currentFolder === context) {
            this.focusFolder(null);
        }
        // run observer functions in reverse order when removing
        const observersReversed = [...this.observers];
        observersReversed.reverse();
        for (const observer of observersReversed) {
            await observer(context, FolderEvent.remove, this);
        }
        context.dispose();
        // remove context
        this.folders.splice(index, 1);
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

    /** find LLDB version and setup path in CodeLLDB */
    async setLLDBVersion() {
        const libPath = await getLLDBLibPath(getSwiftExecutable("lldb"));
        if (!libPath) {
            return;
        }

        const lldbConfig = vscode.workspace.getConfiguration("lldb");
        const configLLDBPath = lldbConfig.get<string>("library");
        if (configLLDBPath === libPath) {
            return;
        }

        // show dialog for setting up LLDB
        vscode.window
            .showInformationMessage(
                "CodeLLDB requires the correct Swift version of LLDB for debugging. Do you want to set this up in your global settings or the workspace settings?",
                "Global",
                "Workspace",
                "Cancel"
            )
            .then(result => {
                switch (result) {
                    case "Global":
                        lldbConfig.update("library", libPath, vscode.ConfigurationTarget.Global);
                        // clear workspace setting
                        lldbConfig.update(
                            "library",
                            undefined,
                            vscode.ConfigurationTarget.Workspace
                        );
                        break;
                    case "Workspace":
                        lldbConfig.update("library", libPath, vscode.ConfigurationTarget.Workspace);
                        break;
                }
            });
    }

    async focusTextEditor(editor?: vscode.TextEditor) {
        if (!editor || !editor.document || editor.document.uri.scheme !== "file") {
            return;
        }
        const url = editor.document.uri;

        const packageFolder = await this.getPackageFolder(url);
        if (packageFolder instanceof FolderContext) {
            this.focusFolder(packageFolder);
        } else if (packageFolder instanceof vscode.Uri) {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(packageFolder);
            if (!workspaceFolder) {
                return;
            }
            await this.unfocusCurrentFolder();
            const folderContext = await this.addPackageFolder(packageFolder, workspaceFolder);
            this.focusFolder(folderContext);
        } else {
            this.focusFolder(null);
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
        do {
            if (await pathExists(currentFolder, "Package.swift")) {
                packagePath = currentFolder;
            }
            currentFolder = path.dirname(currentFolder);
        } while (currentFolder !== workspacePath);

        if (packagePath) {
            return vscode.Uri.file(packagePath);
        } else {
            return;
        }
    }

    /** send unfocus event to current focussed folder and clear current folder */
    private async unfocusCurrentFolder() {
        // send unfocus event for previous folder observers
        if (this.currentFolder !== undefined) {
            await this.fireEvent(this.currentFolder, FolderEvent.unfocus);
        }
        this.currentFolder = undefined;
    }

    private observers: Set<WorkspaceFoldersObserver> = new Set();
}

/** Workspace Folder events */
export class FolderEvent {
    /** Workspace folder has been added */
    static add = new FolderEvent("add");
    /** Workspace folder has been removed */
    static remove = new FolderEvent("remove");
    /** Workspace folder has gained focus via a file inside the folder becoming the actively edited file */
    static focus = new FolderEvent("focus");
    /** Workspace folder loses focus because another workspace folder gained it */
    static unfocus = new FolderEvent("unfocus");
    /** Package.swift has been updated */
    static packageUpdated = new FolderEvent("packageUpdated");
    /** Package.resolved has been updated */
    static resolvedUpdated = new FolderEvent("resolvedUpdated");

    constructor(private readonly name: string) {
        this.name = name;
    }

    toString() {
        return this.name;
    }
}

/** Workspace Folder observer function */
export type WorkspaceFoldersObserver = (
    folder: FolderContext | null,
    operation: FolderEvent,
    workspace: WorkspaceContext
) => unknown;
