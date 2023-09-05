//===----------------------------------------------------------------------===//
//
// This source file is part of the VSCode Swift open source project
//
// Copyright (c) 2023 the VSCode Swift project authors
// Licensed under Apache License v2.0
//
// See LICENSE.txt for license information
// See CONTRIBUTORS.txt for the list of VSCode Swift project authors
//
// SPDX-License-Identifier: Apache-2.0
//
//===----------------------------------------------------------------------===//

import * as vscode from "vscode";
import { WorkspaceContext } from "../WorkspaceContext";
import configuration from "../configuration";

export function registerLLDBDebugAdapter(workspaceContext: WorkspaceContext): vscode.Disposable {
    class LLDBDebugAdapterExecutableFactory implements vscode.DebugAdapterDescriptorFactory {
        createDebugAdapterDescriptor(
            _session: vscode.DebugSession,
            executable: vscode.DebugAdapterExecutable | undefined
        ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
            // use the executable specified in the settings or use version in toolchain
            if (!executable) {
                const lldbDebugAdapterPath =
                    configuration.debugger.debugAdapterPath.length > 0
                        ? configuration.debugger.debugAdapterPath
                        : workspaceContext.toolchain.getToolchainExecutable("lldb-vscode");
                executable = new vscode.DebugAdapterExecutable(lldbDebugAdapterPath, [], {});
            }

            // make VS Code launch the debug adapter executable
            return executable;
        }
    }

    const debugAdpaterFactory = vscode.debug.registerDebugAdapterDescriptorFactory(
        "swift-lldb",
        new LLDBDebugAdapterExecutableFactory()
    );
    const debugConfigProvider = vscode.debug.registerDebugConfigurationProvider(
        "swift-lldb",
        new LLDBDebugConfigurationProvider()
    );
    return {
        dispose: () => {
            debugConfigProvider.dispose();
            debugAdpaterFactory.dispose();
        },
    };
}

/** Provide configurations for lldb-vscode
 *
 * Converts launch configuration that user supplies into a version that the lldb-vscode
 * debug adapter will use. Primarily it converts the environment variables from Object
 * to an array of strings in format "var=value".
 *
 * This could also be used to augment the configuration with values from the settings
 * althought it isn't at the moment.
 */
class LLDBDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    async resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        launchConfig: vscode.DebugConfiguration,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        cancellation?: vscode.CancellationToken
    ): Promise<vscode.DebugConfiguration> {
        launchConfig.env = this.convertEnvironmentVariables(launchConfig.env);
        return launchConfig;
    }

    convertEnvironmentVariables(
        map: { [key: string]: string } | undefined
    ): { [key: string]: string } | string[] | undefined {
        if (map === undefined) {
            return undefined;
        }
        return Object.entries(map).map(([key, value]) => `${key}=${value}`);
    }
}
