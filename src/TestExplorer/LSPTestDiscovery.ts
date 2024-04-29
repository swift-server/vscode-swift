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
import * as TestDiscovery from "./TestDiscovery";
import { workspaceTestsRequest } from "../sourcekit-lsp/lspExtensions";
import { isPathInsidePath } from "../utilities/utilities";
import { LanguageClientManager } from "../sourcekit-lsp/LanguageClientManager";

/**
 * Used to augment test discovery via `swift test --list-tests`.
 *
 * Uses document symbol request to keep a running copy of all the test methods
 * in a file. When a file is saved it checks to see if any new methods have been
 * added, or if any methods have been removed and edits the test items based on
 * these results.
 */
export class LSPTestDiscovery {
    constructor(private languageClient: LanguageClientManager) {}
    /**
     * Used to augment test discovery via `swift test --list-tests`.
     *
     * Parses result of any document symbol request to add/remove tests from
     * the current file.
     */
    getTests(symbols: vscode.DocumentSymbol[], uri: vscode.Uri): TestDiscovery.TestClass[] {
        return symbols
            .filter(
                symbol =>
                    symbol.kind === vscode.SymbolKind.Class ||
                    symbol.kind === vscode.SymbolKind.Namespace
            )
            .map(symbol => {
                const functions = symbol.children
                    .filter(func => func.kind === vscode.SymbolKind.Method)
                    .filter(func => func.name.match(/^test.*\(\)/))
                    .map(func => {
                        const openBrackets = func.name.indexOf("(");
                        let funcName = func.name;
                        if (openBrackets) {
                            funcName = func.name.slice(0, openBrackets);
                        }
                        return {
                            name: funcName,
                            location: new vscode.Location(uri, func.range),
                        };
                    });
                const location =
                    symbol.kind === vscode.SymbolKind.Class
                        ? new vscode.Location(uri, symbol.range)
                        : undefined;
                // As we cannot recognise if a symbol is a new XCTestCase class we have
                // to treat everything as an extension of existing classes
                return {
                    name: symbol.name,
                    location: location,
                    extension: true, //symbol.kind === vscode.SymbolKind.Namespace
                    functions: functions,
                };
            })
            .reduce((result, current) => {
                const index = result.findIndex(item => item.name === current.name);
                if (index !== -1) {
                    result[index].functions = [...result[index].functions, ...current.functions];
                    result[index].location = result[index].location ?? current.location;
                    result[index].extension = result[index].extension || current.extension;
                    return result;
                } else {
                    return [...result, current];
                }
            }, new Array<TestDiscovery.TestClass>());
    }

    /**
     * Return list of workspace tests
     * @param workspaceRoot Root of current workspace folder
     */
    async getWorkspaceTests(workspaceRoot: vscode.Uri): Promise<TestDiscovery.TestClass[]> {
        return await this.languageClient.useLanguageClient(async (client, token) => {
            const tests = await client.sendRequest(workspaceTestsRequest, {}, token);
            const testsInWorkspace = tests.filter(item =>
                isPathInsidePath(
                    client.protocol2CodeConverter.asLocation(item.location).uri.fsPath,
                    workspaceRoot.fsPath
                )
            );
            const classes = testsInWorkspace
                .filter(item => {
                    return (
                        item.kind === langclient.SymbolKind.Class &&
                        isPathInsidePath(
                            client.protocol2CodeConverter.asLocation(item.location).uri.fsPath,
                            workspaceRoot.fsPath
                        )
                    );
                })
                .map(item => {
                    const functions = testsInWorkspace
                        .filter(func => func.containerName === item.name)
                        .map(func => {
                            const openBrackets = func.name.indexOf("(");
                            let funcName = func.name;
                            if (openBrackets) {
                                funcName = func.name.slice(0, openBrackets);
                            }
                            return {
                                name: funcName,
                                location: client.protocol2CodeConverter.asLocation(func.location),
                            };
                        });
                    return {
                        name: item.name,
                        location: client.protocol2CodeConverter.asLocation(item.location),
                        functions: functions,
                    };
                });
            return classes;
        });
    }
}
