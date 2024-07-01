//===----------------------------------------------------------------------===//
//
// This source file is part of the VS Code Swift open source project
//
// Copyright (c) 2024 the VS Code Swift project authors
// Licensed under Apache License v2.0
//
// See LICENSE.txt for license information
// See CONTRIBUTORS.txt for the list of VS Code Swift project authors
//
// SPDX-License-Identifier: Apache-2.0
//
//===----------------------------------------------------------------------===//

import * as vscode from "vscode";
import configuration from "./configuration";

/** The separator to use between paths in the PATH environment variable */
const pathSeparator: string = process.platform === "win32" ? ";" : ":";

/**
 * Configures Swift environment variables for VS Code. Will automatically update
 * whenever the configuration changes.
 */
export class SwiftEnvironmentVariablesManager implements vscode.Disposable {
    private subscriptions: vscode.Disposable[] = [];

    constructor(private context: vscode.ExtensionContext) {
        this.update();
        this.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(event => {
                if (
                    event.affectsConfiguration("swift.enableTerminalEnvironment") ||
                    event.affectsConfiguration("swift.path") ||
                    event.affectsConfiguration("swift.swiftEnvironmentVariables")
                ) {
                    this.update();
                }
            })
        );
    }

    dispose() {
        this.context.environmentVariableCollection.clear();
        for (const disposable of this.subscriptions) {
            disposable.dispose();
        }
    }

    private update() {
        const environment = this.context.environmentVariableCollection;
        environment.clear();

        if (!configuration.enableTerminalEnvironment) {
            return;
        }

        const pathEnv = process.env["PATH"] ?? "";
        if (!pathEnv.includes(configuration.path)) {
            environment.prepend("PATH", configuration.path + pathSeparator);
        }
        for (const variable in configuration.swiftEnvironmentVariables) {
            environment.replace(variable, configuration.swiftEnvironmentVariables[variable]);
        }
    }
}

/**
 * A {@link vscode.TerminalProfileProvider} used to create a terminal with the appropriate Swift
 * environment variables applied.
 */
export class SwiftTerminalProfileProvider implements vscode.TerminalProfileProvider {
    provideTerminalProfile(): vscode.ProviderResult<vscode.TerminalProfile> {
        const env: vscode.TerminalOptions["env"] = {
            ...configuration.swiftEnvironmentVariables,
        };
        const pathEnv = process.env["PATH"] ?? "";
        if (!pathEnv.includes(configuration.path)) {
            env["PATH"] = configuration.path + pathSeparator + pathEnv;
        }
        return new vscode.TerminalProfile({
            name: "Swift Terminal",
            iconPath: new vscode.ThemeIcon("swift-icon"),
            env,
        });
    }
}
