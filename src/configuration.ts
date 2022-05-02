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

/** sourcekit-lsp configuration */
export interface LSPConfiguration {
    /** Path to sourcekit-lsp executable */
    readonly serverPath: string;
    /** Arguments to pass to sourcekit-lsp executable */
    readonly serverArguments: string[];
    /** Are inlay hints enabled */
    readonly inlayHintsEnabled: boolean;
}

/** destination configuration */
export interface DestinationConfiguration {
    /** Path to destination sdk */
    readonly sdk: string;
}

/**
 * Type-safe wrapper around configuration settings.
 */
const configuration = {
    /** sourcekit-lsp configuration */
    get lsp(): LSPConfiguration {
        return {
            get serverPath(): string {
                return vscode.workspace
                    .getConfiguration("sourcekit-lsp")
                    .get<string>("serverPath", "");
            },
            get serverArguments(): string[] {
                return vscode.workspace
                    .getConfiguration("sourcekit-lsp")
                    .get<string[]>("serverArguments", []);
            },
            get inlayHintsEnabled(): boolean {
                return vscode.workspace
                    .getConfiguration("sourcekit-lsp")
                    .get<boolean>("inlayHints.enabled", true);
            },
        };
    },
    /** destination configuration */
    get destination(): DestinationConfiguration {
        return {
            get sdk(): string {
                return vscode.workspace
                    .getConfiguration("swift")
                    .get<string>("destination.SDK", "");
            },
        };
    },

    /** Files and directories to exclude from the Package Dependencies view. */
    get excludePathsFromPackageDependencies(): string[] {
        return vscode.workspace
            .getConfiguration("swift")
            .get<string[]>("excludePathsFromPackageDependencies", []);
    },
    /** Folders to exclude from package dependency view */
    set excludePathsFromPackageDependencies(value: string[]) {
        vscode.workspace
            .getConfiguration("swift")
            .update("excludePathsFromPackageDependencies", value);
    },
    /** Path to folder that include swift executable */
    get path(): string {
        return vscode.workspace.getConfiguration("swift").get<string>("path", "");
    },
    /** Path to folder that include swift runtime */
    get runtimePath(): string {
        return vscode.workspace.getConfiguration("swift").get<string>("runtimePath", "");
    },
    /** swift build arguments */
    get buildArguments(): string[] {
        return vscode.workspace.getConfiguration("swift").get<string[]>("buildArguments", []);
    },
    /** include build errors in problems view */
    get problemMatchCompileErrors(): boolean {
        return vscode.workspace
            .getConfiguration("swift")
            .get<boolean>("problemMatchCompileErrors", true);
    },
    /** auto-generate launch.json configurations */
    get autoGenerateLaunchConfigurations(): boolean {
        return vscode.workspace
            .getConfiguration("swift")
            .get<boolean>("autoGenerateLaunchConfigurations", true);
    },
    /** background compilation */
    get backgroundCompilation(): boolean {
        return vscode.workspace
            .getConfiguration("swift")
            .get<boolean>("backgroundCompilation", false);
    },
    /** output additional diagnostics */
    get diagnostics(): boolean {
        return vscode.workspace.getConfiguration("swift").get<boolean>("diagnostics", false);
    },
    /** Environment variables to set when running tests */
    get testEnvironmentVariables(): Record<string, string> {
        return vscode.workspace
            .getConfiguration("swift")
            .get<Record<string, string>>("testEnvironmentVariables", {});
    },
};

export default configuration;
