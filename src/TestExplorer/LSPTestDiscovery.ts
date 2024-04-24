//===----------------------------------------------------------------------===//
//
// This source file is part of the VSCode Swift open source project
//
// Copyright (c) 2021-2024 the VSCode Swift project authors
// Licensed under Apache License v2.0
//
// See LICENSE.txt for license information
// See CONTRIBUTORS.txt for the list of VSCode Swift project authors
//
// SPDX-License-Identifier: Apache-2.0
//
//===----------------------------------------------------------------------===//

import * as vscode from "vscode";
import * as TestDiscovery from "./TestDiscovery";
import {
    LSPTestItem,
    textDocumentTestsRequest,
    workspaceTestsRequest,
} from "../sourcekit-lsp/lspExtensions";
import { isPathInsidePath } from "../utilities/utilities";
import { LanguageClientManager } from "../sourcekit-lsp/LanguageClientManager";
import { LanguageClient } from "vscode-languageclient/node";
import { SwiftPackage, TargetType } from "../SwiftPackage";

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
     * Return a list of tests in the supplied document.
     * @param document A document to query
     */
    async getDocumentTests(
        swiftPackage: SwiftPackage,
        document: vscode.Uri
    ): Promise<TestDiscovery.TestClass[]> {
        return await this.languageClient.useLanguageClient(async (client, token) => {
            const workspaceTestCaps =
                client.initializeResult?.capabilities.experimental[textDocumentTestsRequest.method];

            // Only use the lsp for this request if it supports the
            // textDocument/tests method, and is at least version 2.
            if (workspaceTestCaps?.version >= 2) {
                const testsInDocument = await client.sendRequest(
                    textDocumentTestsRequest,
                    { textDocument: { uri: document.toString() } },
                    token
                );
                return this.transform(client, swiftPackage, testsInDocument);
            } else {
                throw new Error("workspace/tests requests not supported");
            }
        });
    }

    /**
     * Return list of workspace tests
     * @param workspaceRoot Root of current workspace folder
     */
    async getWorkspaceTests(
        swiftPackage: SwiftPackage,
        workspaceRoot: vscode.Uri
    ): Promise<TestDiscovery.TestClass[]> {
        return await this.languageClient.useLanguageClient(async (client, token) => {
            const workspaceTestCaps =
                client.initializeResult?.capabilities.experimental[workspaceTestsRequest.method];

            // Only use the lsp for this request if it supports the
            // workspace/tests method, and is at least version 2.
            if (workspaceTestCaps?.version >= 2) {
                const tests = await client.sendRequest(workspaceTestsRequest, {}, token);
                const testsInWorkspace = tests.filter(item =>
                    isPathInsidePath(
                        client.protocol2CodeConverter.asLocation(item.location).uri.fsPath,
                        workspaceRoot.fsPath
                    )
                );

                return this.transform(client, swiftPackage, testsInWorkspace);
            } else {
                throw new Error("workspace/tests requests not supported");
            }
        });
    }

    /**
     * Convert from a collection of LSP TestItems to a collection of
     * TestDiscovery.TestClasses, updating the format of the location.
     */
    private transform(
        client: LanguageClient,
        swiftPackage: SwiftPackage,
        input: LSPTestItem[]
    ): TestDiscovery.TestClass[] {
        return input.map(item => {
            const location = client.protocol2CodeConverter.asLocation(item.location);
            const id = this.transformId(item, location, swiftPackage);
            return {
                ...item,
                id: id,
                location: location,
                children: this.transform(client, swiftPackage, item.children),
            };
        });
    }

    /**
     * If the test is an XCTest, transform the ID provided by the LSP from a
     * swift-testing style ID to one that XCTest can use. This allows the ID to
     * be used to specify to the test runner (xctest or swift-testing) which tests to run.
     */
    private transformId(
        item: LSPTestItem,
        location: vscode.Location,
        swiftPackage: SwiftPackage
    ): string {
        // XCTest: Target.TestClass/testCase
        // swift-testing: TestClass/testCase()
        //                TestClassOrStruct/NestedTestSuite/testCase()

        let id: string = item.id;
        if (item.style === "XCTest") {
            const target = swiftPackage
                .getTargets(TargetType.test)
                .find(target => swiftPackage.getTarget(location.uri.fsPath) === target);

            id = "";
            if (target) {
                id += `${target?.name}.`;
            }
            return id + item.id.replace(/\(\)$/, "");
        } else {
            return item.id;
        }
    }
}
