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
import * as path from "path";
import * as langclient from "vscode-languageclient/node";
import configuration from "../configuration";
import { isPathInsidePath, swiftRuntimeEnv } from "../utilities/utilities";
import { Version } from "../utilities/version";
import { FolderEvent, WorkspaceContext } from "../WorkspaceContext";
import { activateLegacyInlayHints } from "./inlayHints";
import { FolderContext } from "../FolderContext";
import { LanguageClient } from "vscode-languageclient/node";
import { ArgumentFilter, BuildFlags } from "../toolchain/BuildFlags";

/** Manages the creation and destruction of Language clients as we move between
 * workspace folders
 */
export class LanguageClientManager {
    // document selector used by language client
    static appleLangDocumentSelector = [
        { scheme: "file", language: "swift" },
        { scheme: "untitled", language: "swift" },
        { scheme: "file", language: "objective-c" },
        { scheme: "untitled", language: "objective-c" },
        { scheme: "file", language: "objective-cpp" },
        { scheme: "untitled", language: "objective-cpp" },
    ];
    // document selector used by language client
    static cFamilyDocumentSelector = [
        { scheme: "file", language: "c" },
        { scheme: "untitled", language: "c" },
        { scheme: "file", language: "cpp" },
        { scheme: "untitled", language: "cpp" },
    ];
    static get documentSelector(): { scheme: string; language: string }[] {
        let documentSelector: { scheme: string; language: string }[];
        switch (configuration.lsp.supportCFamily) {
            case "enable":
                documentSelector = [
                    ...LanguageClientManager.appleLangDocumentSelector,
                    ...LanguageClientManager.cFamilyDocumentSelector,
                ];
                break;

            case "disable":
                documentSelector = LanguageClientManager.appleLangDocumentSelector;
                break;

            case "cpptools-inactive": {
                const cppToolsActive =
                    vscode.extensions.getExtension("ms-vscode.cpptools")?.isActive;
                documentSelector =
                    cppToolsActive === true
                        ? LanguageClientManager.appleLangDocumentSelector
                        : [
                              ...LanguageClientManager.appleLangDocumentSelector,
                              ...LanguageClientManager.cFamilyDocumentSelector,
                          ];
            }
        }
        documentSelector = documentSelector.filter(doc =>
            configuration.lsp.supportedLanguages.includes(doc.language)
        );
        return documentSelector;
    }

    // build argument to sourcekit-lsp filter
    static buildArgumentFilter: ArgumentFilter[] = [
        { argument: "--build-path", include: 1 },
        { argument: "--scratch-path", include: 1 },
        { argument: "-Xswiftc", include: 1 },
        { argument: "-Xcc", include: 1 },
        { argument: "-Xcxx", include: 1 },
        { argument: "-Xlinker", include: 1 },
        { argument: "-Xclangd", include: 1 },
        { argument: "-index-store-path", include: 1 },
    ];

    /**
     * current running client
     *
     * undefined means not setup
     * null means in the process of restarting
     */
    private languageClient: langclient.LanguageClient | null | undefined;
    private cancellationToken?: vscode.CancellationTokenSource;
    private legacyInlayHints?: vscode.Disposable;
    private restartedPromise?: Promise<void>;
    private currentWorkspaceFolder?: vscode.Uri;
    private waitingOnRestartCount: number;
    private clientReadyPromise?: Promise<void>;
    public documentSymbolWatcher?: (
        document: vscode.TextDocument,
        symbols: vscode.DocumentSymbol[] | null | undefined
    ) => void;
    private subscriptions: { dispose(): unknown }[];
    private singleServerSupport: boolean;
    // used by single server support to keep a record of the project folders
    // that are not at the root of their workspace
    public subFolderWorkspaces: vscode.Uri[];

    constructor(public workspaceContext: WorkspaceContext) {
        this.singleServerSupport = workspaceContext.swiftVersion.isGreaterThanOrEqual(
            new Version(5, 7, 0)
        );
        this.subscriptions = [];
        this.subFolderWorkspaces = [];
        if (this.singleServerSupport) {
            // add/remove folders from server
            const observeFoldersDisposable = workspaceContext.observeFolders(
                async (folderContext, event) => {
                    if (!folderContext) {
                        return;
                    }
                    switch (event) {
                        case FolderEvent.add:
                            this.addFolder(folderContext);
                            break;
                        case FolderEvent.remove:
                            this.removeFolder(folderContext);
                            break;
                    }
                }
            );
            this.subscriptions.push(observeFoldersDisposable);
            this.setLanguageClientFolder(undefined);
        } else {
            // stop and start server for each folder based on which file I am looking at
            const observeFoldersDisposable = workspaceContext.observeFolders(
                async (folderContext, event) => {
                    switch (event) {
                        case FolderEvent.add:
                            if (folderContext && folderContext.folder) {
                                // if active document is inside folder then setup language client
                                if (this.isActiveFileInFolder(folderContext.folder)) {
                                    await this.setLanguageClientFolder(folderContext.folder);
                                }
                            }
                            break;
                        case FolderEvent.focus:
                            await this.setLanguageClientFolder(folderContext?.folder);
                            break;
                    }
                }
            );
            this.subscriptions.push(observeFoldersDisposable);
        }
        // on change config restart server
        const onChangeConfig = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration("swift.sourcekit-lsp")) {
                vscode.window
                    .showInformationMessage(
                        "Changing LSP settings requires the language server be restarted.",
                        "Ok"
                    )
                    .then(selected => {
                        if (selected === "Ok") {
                            this.restart();
                        }
                    });
            }
        });

        this.subscriptions.push(onChangeConfig);

        // Swift versions prior to 5.6 don't support file changes, so need to restart
        // lSP server when a file is either created or deleted
        if (workspaceContext.swiftVersion.isLessThan(new Version(5, 6, 0))) {
            workspaceContext.outputChannel.logDiagnostic("LSP: Adding new/delete file handlers");
            // restart LSP server on creation of a new file
            const onDidCreateFileDisposable = vscode.workspace.onDidCreateFiles(() => {
                this.restart();
            });
            // restart LSP server on deletion of a file
            const onDidDeleteFileDisposable = vscode.workspace.onDidDeleteFiles(() => {
                this.restart();
            });
            this.subscriptions.push(onDidCreateFileDisposable, onDidDeleteFileDisposable);
        }

        this.waitingOnRestartCount = 0;
        this.documentSymbolWatcher = undefined;
        this.cancellationToken = new vscode.CancellationTokenSource();
    }

    dispose() {
        this.cancellationToken?.cancel();
        this.cancellationToken?.dispose();
        this.legacyInlayHints?.dispose();
        this.subscriptions.forEach(item => item.dispose());
        this.languageClient?.stop();
    }

    /**
     * Use language client safely. Provides a cancellation token to the function
     * which can be used to safely ensure language client request are cancelled
     * if the language is shutdown.
     * @param process process using language client
     * @returns result of process
     */
    async useLanguageClient<Return>(process: {
        (
            client: langclient.LanguageClient,
            cancellationToken: vscode.CancellationToken
        ): Promise<Return>;
    }): Promise<Return> {
        if (!this.languageClient || !this.clientReadyPromise) {
            throw LanguageClientError.LanguageClientUnavailable;
        }
        return this.clientReadyPromise.then(
            () => {
                if (!this.languageClient || !this.cancellationToken) {
                    throw LanguageClientError.LanguageClientUnavailable;
                }
                return process(this.languageClient, this.cancellationToken.token);
            },
            reason => reason
        );
    }

    /** Restart language client */
    async restart() {
        // force restart of language client
        await this.setLanguageClientFolder(this.currentWorkspaceFolder, true);
    }

    private async addFolder(folderContext: FolderContext) {
        if (!folderContext.isRootFolder) {
            this.useLanguageClient(async client => {
                const uri = folderContext.folder;
                this.subFolderWorkspaces.push(folderContext.folder);

                const workspaceFolder = {
                    uri: client.code2ProtocolConverter.asUri(uri),
                    name: FolderContext.uriName(uri),
                };
                client.sendNotification(langclient.DidChangeWorkspaceFoldersNotification.type, {
                    event: { added: [workspaceFolder], removed: [] },
                });
            });
        }
    }

    private async removeFolder(folderContext: FolderContext) {
        if (!folderContext.isRootFolder) {
            this.useLanguageClient(async client => {
                const uri = folderContext.folder;
                this.subFolderWorkspaces = this.subFolderWorkspaces.filter(item => item !== uri);

                const workspaceFolder = {
                    uri: client.code2ProtocolConverter.asUri(uri),
                    name: FolderContext.uriName(uri),
                };
                client.sendNotification(langclient.DidChangeWorkspaceFoldersNotification.type, {
                    event: { added: [], removed: [workspaceFolder] },
                });
            });
        }
    }

    private async addSubFolderWorkspaces(client: LanguageClient) {
        for (const uri of this.subFolderWorkspaces) {
            const workspaceFolder = {
                uri: client.code2ProtocolConverter.asUri(uri),
                name: FolderContext.uriName(uri),
            };
            client.sendNotification(langclient.DidChangeWorkspaceFoldersNotification.type, {
                event: { added: [workspaceFolder], removed: [] },
            });
        }
    }

    /** Set folder for LSP server
     *
     * If server is already running then check if the workspace folder is the same if
     * it isn't then restart the server using the new workspace folder.
     */
    private async setLanguageClientFolder(uri?: vscode.Uri, forceRestart = false) {
        if (this.languageClient === undefined) {
            this.currentWorkspaceFolder = uri;
            this.restartedPromise = this.setupLanguageClient(uri);
            return;
        } else {
            // don't check for undefined uri's or if the current workspace is the same if we are
            // running a single server. The only way we can get here while using a single server
            // is when restart is called.
            if (!this.singleServerSupport) {
                if (uri === undefined || (this.currentWorkspaceFolder === uri && !forceRestart)) {
                    return;
                }
            }
            let workspaceFolder: vscode.WorkspaceFolder | undefined;
            if (uri) {
                workspaceFolder = {
                    uri: uri,
                    name: FolderContext.uriName(uri),
                    index: 0,
                };
            }
            this.restartLanguageClient(workspaceFolder);
        }
    }

    /**
     * Restart language client using supplied workspace folder
     * @param workspaceFolder workspace folder to send to server
     * @returns when done
     */
    private async restartLanguageClient(workspaceFolder: vscode.WorkspaceFolder | undefined) {
        // count number of setLanguageClientFolder calls waiting on startedPromise
        this.waitingOnRestartCount += 1;
        // if in the middle of a restart then we have to wait until that
        // restart has finished
        if (this.restartedPromise) {
            try {
                await this.restartedPromise;
            } catch (error) {
                //ignore error
            }
        }
        this.waitingOnRestartCount -= 1;
        // only continue if no more calls are waiting on startedPromise
        if (this.waitingOnRestartCount !== 0) {
            return;
        }

        const client = this.languageClient;
        // language client is set to null while it is in the process of restarting
        this.languageClient = null;
        this.currentWorkspaceFolder = workspaceFolder?.uri;
        this.legacyInlayHints?.dispose();
        this.legacyInlayHints = undefined;
        if (client) {
            this.cancellationToken?.cancel();
            this.cancellationToken?.dispose();
            this.restartedPromise = client
                .stop()
                .then(async () => {
                    await this.setupLanguageClient(workspaceFolder?.uri);
                })
                .catch(async reason => {
                    // error message matches code here https://github.com/microsoft/vscode-languageserver-node/blob/2041784436fed53f4e77267a49396bca22a7aacf/client/src/common/client.ts#L1409C1-L1409C54
                    if (reason.message === "Stopping the server timed out") {
                        await this.setupLanguageClient(workspaceFolder?.uri);
                    }
                    this.workspaceContext.outputChannel.log(`${reason}`);
                });
        }
    }

    private isActiveFileInFolder(uri: vscode.Uri): boolean {
        if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document) {
            // if active document is inside folder then setup language client
            const activeDocPath = vscode.window.activeTextEditor.document.uri.fsPath;
            if (isPathInsidePath(activeDocPath, uri.fsPath)) {
                return true;
            }
        }
        return false;
    }

    private async setupLanguageClient(folder?: vscode.Uri) {
        if (configuration.lsp.disable) {
            this.languageClient = undefined;
            return;
        }
        const client = this.createLSPClient(folder);
        return this.startClient(client);
    }

    private createLSPClient(folder?: vscode.Uri): langclient.LanguageClient {
        const toolchainSourceKitLSP =
            this.workspaceContext.toolchain.getToolchainExecutable("sourcekit-lsp");
        const lspConfig = configuration.lsp;
        const serverPathConfig = lspConfig.serverPath;
        const serverPath = serverPathConfig.length > 0 ? serverPathConfig : toolchainSourceKitLSP;
        const buildFlags = this.workspaceContext.toolchain.buildFlags;
        const sdkArguments = [
            ...buildFlags.swiftDriverSDKFlags(true),
            ...buildFlags.swiftDriverTargetFlags(true),
            ...BuildFlags.filterArguments(
                configuration.buildArguments.concat(buildFlags.buildPathFlags()),
                LanguageClientManager.buildArgumentFilter
            ),
        ];

        const sourcekit: langclient.Executable = {
            command: serverPath,
            args: lspConfig.serverArguments.concat(sdkArguments),
            options: {
                env: {
                    ...process.env,
                    ...configuration.swiftEnvironmentVariables,
                    ...swiftRuntimeEnv(),
                },
            },
        };

        // if path to LSP server is not equal to the path to swift and both are set, then
        // pass swift toolchain to the LSP server
        if (
            serverPathConfig.length > 0 &&
            configuration.path.length > 0 &&
            serverPathConfig !== toolchainSourceKitLSP
        ) {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            sourcekit.options = {
                env: {
                    ...sourcekit.options?.env,
                    SOURCEKIT_TOOLCHAIN_PATH: this.workspaceContext.toolchain.toolchainPath,
                },
            };
        }

        const serverOptions: langclient.ServerOptions = sourcekit;
        let workspaceFolder = undefined;
        if (folder) {
            workspaceFolder = { uri: folder, name: FolderContext.uriName(folder), index: 0 };
        }

        const clientOptions: langclient.LanguageClientOptions = {
            documentSelector: LanguageClientManager.documentSelector,
            revealOutputChannelOn: langclient.RevealOutputChannelOn.Never,
            workspaceFolder: workspaceFolder,
            middleware: {
                provideDocumentSymbols: async (document, token, next) => {
                    const result = await next(document, token);
                    const documentSymbols = result as vscode.DocumentSymbol[];
                    if (this.documentSymbolWatcher && documentSymbols) {
                        this.documentSymbolWatcher(document, documentSymbols);
                    }
                    return result;
                },
                provideDefinition: async (document, position, token, next) => {
                    const result = await next(document, position, token);
                    const definitions = result as vscode.Location[];
                    if (
                        definitions &&
                        path.extname(definitions[0].uri.path) === ".swiftinterface"
                    ) {
                        const uri = definitions[0].uri.with({ scheme: "readonly" });
                        return new vscode.Location(uri, definitions[0].range);
                    }
                    return result;
                },
                // temporarily remove text edit from Inlay hints while SourceKit-LSP
                // returns invalid replacement text
                provideInlayHints: async (document, position, token, next) => {
                    const result = await next(document, position, token);
                    // remove textEdits for swift version earlier than 5.10 as it sometimes
                    // generated invalid textEdits
                    if (this.workspaceContext.swiftVersion.isLessThan(new Version(5, 10, 0))) {
                        result?.forEach(r => (r.textEdits = undefined));
                    }
                    return result;
                },
            },
            errorHandler: new SourceKitLSPErrorHandler(5),
        };

        return new langclient.LanguageClient(
            "swift.sourcekit-lsp",
            "SourceKit Language Server",
            serverOptions,
            clientOptions
        );
    }

    private async startClient(client: langclient.LanguageClient) {
        client.onDidChangeState(e => {
            // if state is now running add in any sub-folder workspaces that
            // we have cached. If this is the first time we are starting then
            // we won't have any sub folder workspaces, but if the server crashed
            // or we forced a restart then we need to do this
            if (
                e.oldState === langclient.State.Starting &&
                e.newState === langclient.State.Running
            ) {
                this.addSubFolderWorkspaces(client);
            }
            //console.log(e);
        });
        if (client.clientOptions.workspaceFolder) {
            this.workspaceContext.outputChannel.log(
                `SourceKit-LSP setup for ${FolderContext.uriName(
                    client.clientOptions.workspaceFolder.uri
                )}`
            );
        } else {
            this.workspaceContext.outputChannel.log(`SourceKit-LSP setup`);
        }

        // start client
        this.clientReadyPromise = client
            .start()
            .then(() => {
                if (this.workspaceContext.swiftVersion.isLessThan(new Version(5, 7, 0))) {
                    this.legacyInlayHints = activateLegacyInlayHints(client);
                }
            })
            .catch(reason => {
                this.workspaceContext.outputChannel.log(`${reason}`);
                // if language client failed to initialise then shutdown and set to undefined
                this.languageClient?.stop();
                this.languageClient = undefined;
                throw reason;
            });

        this.languageClient = client;
        this.cancellationToken = new vscode.CancellationTokenSource();

        return this.clientReadyPromise;
    }
}

/**
 * SourceKit-LSP error handler. Copy of the default error handler, except it includes
 * an error message that asks if you want to restart the sourcekit-lsp server again
 * after so many crashes
 */
class SourceKitLSPErrorHandler implements langclient.ErrorHandler {
    private restarts: number[];

    constructor(private maxRestartCount: number) {
        this.restarts = [];
    }
    /**
     * An error has occurred while writing or reading from the connection.
     *
     * @param error - the error received
     * @param message - the message to be delivered to the server if know.
     * @param count - a count indicating how often an error is received. Will
     *  be reset if a message got successfully send or received.
     */
    error(
        error: Error,
        message: langclient.Message | undefined,
        count: number | undefined
    ): langclient.ErrorHandlerResult | Promise<langclient.ErrorHandlerResult> {
        if (count && count <= 3) {
            return { action: langclient.ErrorAction.Continue };
        }
        return { action: langclient.ErrorAction.Shutdown };
    }
    /**
     * The connection to the server got closed.
     */
    closed(): langclient.CloseHandlerResult | Promise<langclient.CloseHandlerResult> {
        this.restarts.push(Date.now());
        if (this.restarts.length <= this.maxRestartCount) {
            return { action: langclient.CloseAction.Restart };
        } else {
            const diff = this.restarts[this.restarts.length - 1] - this.restarts[0];
            if (diff <= 3 * 60 * 1000) {
                return new Promise<langclient.CloseHandlerResult>(resolve => {
                    vscode.window
                        .showErrorMessage(
                            `The SourceKit-LSP server crashed ${
                                this.maxRestartCount + 1
                            } times in the last 3 minutes. See the output for more information. Do you want to restart it again.`,
                            "Yes",
                            "No"
                        )
                        .then(result => {
                            if (result === "Yes") {
                                this.restarts = [];
                                resolve({ action: langclient.CloseAction.Restart });
                            } else {
                                resolve({ action: langclient.CloseAction.DoNotRestart });
                            }
                        });
                });
            } else {
                this.restarts.shift();
                return { action: langclient.CloseAction.Restart };
            }
        }
    }
}

/** Language client errors */
export enum LanguageClientError {
    LanguageClientUnavailable,
}
