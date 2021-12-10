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

import * as vscode from 'vscode';
import * as commands from './commands';
import { PackageDependenciesProvider } from './PackageDependencyProvider';
import { PackageWatcher } from './PackageWatcher';
import { SwiftTaskProvider } from './SwiftTaskProvider';
import { WorkspaceContext } from './WorkspaceContext';
import { activate as activateSourceKitLSP } from './sourcekit-lsp/extension';

/**
 * Activate the extension. This is the main entry point.
 */
export async function activate(context: vscode.ExtensionContext) {
	console.debug('Activating Swift for Visual Studio Code...');

	await activateSourceKitLSP(context);

	let workspaceContext = new WorkspaceContext(context);
	let onWorkspaceChange = vscode.workspace.onDidChangeWorkspaceFolders((event) => {
		if (workspaceContext === undefined) { console.log("Trying to run onDidChangeWorkspaceFolders on deleted context"); return; }
		workspaceContext.onDidChangeWorkspaceFolders(event);
	});

	// Register tasks and commands.
	const taskProvider = vscode.tasks.registerTaskProvider('swift', new SwiftTaskProvider(workspaceContext));
	commands.register(workspaceContext);

	// observer for logging workspace folder addition/removal
	let logObserver = workspaceContext.observerFolders((folder, operation) => {
		console.log(`${operation}: ${folder.rootFolder.uri.fsPath}`);
	});

	// observer that will add dependency view based on whether a root workspace folder has been added
	let addDependencyViewObserver = workspaceContext.observerFolders((folder, operation) => {
		if (folder.isRootFolder && operation === 'add') {
			const dependenciesProvider = new PackageDependenciesProvider(folder);
			const dependenciesView = vscode.window.createTreeView('packageDependencies', {
				treeDataProvider: dependenciesProvider,
				showCollapseAll: true
			});
			context.subscriptions.push(dependenciesView);
		}
	});

	if (vscode.workspace.workspaceFolders !== undefined) {
		for (const folder of vscode.workspace.workspaceFolders) {
			await workspaceContext.addFolder(folder);
		}
	}

	// Register any disposables for cleanup when the extension deactivates.
	context.subscriptions.push(onWorkspaceChange, addDependencyViewObserver, logObserver, taskProvider, workspaceContext);
}

/**
 * Deactivate the extension.
 * 
 * Any disposables registered in `context.subscriptions` will be automatically
 * disposed of, so there's nothing left to do here.
 */
export function deactivate() {}

