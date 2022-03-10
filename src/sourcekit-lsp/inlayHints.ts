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

import * as vscode from "vscode";
import * as langclient from "vscode-languageclient/node";
import { LanguageClientManager } from "./LanguageClientManager";
import { inlayHintsRequest } from "./lspExtensions";

// The implementation is loosely based on the rust-analyzer implementation
// of inlay hints: https://github.com/rust-analyzer/rust-analyzer/blob/master/editors/code/src/inlay_hints.ts

// Note that once support for inlay hints is officially added to LSP/VSCode,
// this module providing custom decorations will no longer be needed!

class SwiftInlayHintsProvider implements vscode.InlayHintsProvider {
    onDidChangeInlayHints?: vscode.Event<void> | undefined;

    constructor(private client: langclient.LanguageClient) {}

    provideInlayHints(
        document: vscode.TextDocument,
        range: vscode.Range,
        token: vscode.CancellationToken
    ): Thenable<vscode.InlayHint[]> {
        const params = {
            textDocument: langclient.TextDocumentIdentifier.create(document.uri.toString(true)),
            // range: range,
        };
        const result = this.client.sendRequest(inlayHintsRequest, params, token);
        return result.then(
            hints => {
                return hints.map(hint => {
                    let label = hint.label;
                    let kind: vscode.InlayHintKind | undefined;
                    switch (hint.category) {
                        case "type":
                            kind = vscode.InlayHintKind.Type;
                            label = `: ${label}`;
                            break;
                        case "parameter":
                            kind = vscode.InlayHintKind.Parameter;
                            break;
                    }
                    return {
                        label: label,
                        position: hint.position,
                        kind: kind,
                        paddingLeft: true,
                    };
                });
            },
            reason => reason
        );
    }
}

export function activateInlayHints(client: langclient.LanguageClient): vscode.Disposable {
    const inlayHint = vscode.languages.registerInlayHintsProvider(
        LanguageClientManager.documentSelector,
        new SwiftInlayHintsProvider(client)
    );
    return inlayHint;
}
