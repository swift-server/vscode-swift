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
import configuration from "../configuration";
import { FolderEvent, WorkspaceContext } from "../WorkspaceContext";
import { LcovResults } from "./LcovResults";

export class TestCoverageRenderer implements vscode.Disposable {
    private displayResults: boolean;
    private subscriptions: { dispose(): unknown }[];
    private currentEditor: vscode.TextEditor | undefined;
    private coverageHitDecorationType: vscode.TextEditorDecorationType;
    private coverageMissDecorationType: vscode.TextEditorDecorationType;
    private statusBarItem: vscode.StatusBarItem;

    constructor(private workspaceContext: WorkspaceContext) {
        this.displayResults = false;
        this.currentEditor = vscode.window.activeTextEditor;

        // decoration types for hit and missed lines of code
        const { hit, miss } = this.getTestCoverageDecorationTypes();
        this.coverageHitDecorationType = vscode.window.createTextEditorDecorationType(hit);
        this.coverageMissDecorationType = vscode.window.createTextEditorDecorationType(miss);

        // status bar item displaying percentage of coverage for the current file
        this.statusBarItem = this.createCoverageStatusItem();

        // set observer on all currently loaded folders lcov results
        workspaceContext.folders.forEach(folder => {
            folder.lcovResults.observer = results => {
                this.resultsChanged(results);
            };
        });
        // whenever a new folder is added set observer on lcov results
        const folderAddedObserver = workspaceContext.observeFolders((folder, event) => {
            if (!folder) {
                return;
            }
            switch (event) {
                case FolderEvent.add:
                    folder.lcovResults.observer = results => {
                        this.resultsChanged(results);
                    };
            }
        });
        // add event listener for when the active edited text document changes
        const onDidChangeActiveWindow = vscode.window.onDidChangeActiveTextEditor(async editor => {
            if (this.currentEditor) {
                this.clear(this.currentEditor);
            }
            if (editor) {
                this.render(editor);
                this.currentEditor = editor;
            }
        });
        // on configuration change rebuild test coverage decorations with new colors
        const onChangeConfig = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration("swift.coverage.colors")) {
                this.resetTestCoverageEditorColors();
            }
            if (event.affectsConfiguration("swift.coverage.alwaysShowStatusItem")) {
                this.updateCoverageStatusItem();
            }
        });
        this.subscriptions = [folderAddedObserver, onDidChangeActiveWindow, onChangeConfig];
    }

    dispose() {
        this.subscriptions.forEach(item => item.dispose());
        this.coverageHitDecorationType.dispose();
        this.coverageMissDecorationType.dispose();
    }

    private createCoverageStatusItem(): vscode.StatusBarItem {
        // status bar item displaying percentage of coverage for the current file
        const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        if (configuration.alwaysShowCoverageStatusItem) {
            statusBarItem.text = "Coverage: Off";
            statusBarItem.accessibilityInformation = {
                label: "Coverage: Off",
                role: "button",
            };
            statusBarItem.command = "swift.toggleTestCoverage";
            statusBarItem.show();
        }
        return statusBarItem;
    }

    /** Update coverage status bar item after configuration has changed */
    private updateCoverageStatusItem() {
        if (configuration.alwaysShowCoverageStatusItem) {
            this.updateCoverageStatusItemText(this.statusItemCoverageOffText());
            this.statusBarItem.command = "swift.toggleTestCoverage";
            this.statusBarItem.show();
        } else {
            this.statusBarItem.command = undefined;
            this.statusBarItem.hide();
        }
    }

    /** Update text and accessibility data for test coverage status item */
    private updateCoverageStatusItemText(text: string) {
        this.statusBarItem.text = text;
        this.statusBarItem.accessibilityInformation = {
            label: text,
            role: configuration.alwaysShowCoverageStatusItem ? "button" : undefined,
        };
    }

    /** Reset test coverage colors. Most likely because they have been edited in the settings */
    private resetTestCoverageEditorColors() {
        if (this.currentEditor) {
            this.clear(this.currentEditor);
        }
        this.coverageHitDecorationType.dispose();
        this.coverageMissDecorationType.dispose();
        const { hit, miss } = this.getTestCoverageDecorationTypes();
        this.coverageHitDecorationType = vscode.window.createTextEditorDecorationType(hit);
        this.coverageMissDecorationType = vscode.window.createTextEditorDecorationType(miss);
    }

    /** Return decoration render options for hit and miss decorations */
    private getTestCoverageDecorationTypes(): {
        hit: vscode.DecorationRenderOptions;
        miss: vscode.DecorationRenderOptions;
    } {
        const hitDecorationType: vscode.DecorationRenderOptions = {
            isWholeLine: true,
            dark: {
                backgroundColor: configuration.coverageHitColorDarkMode,
                overviewRulerColor: configuration.coverageHitColorDarkMode,
            },
            light: {
                backgroundColor: configuration.coverageHitColorLightMode,
                overviewRulerColor: configuration.coverageHitColorLightMode,
            },
        };
        const missDecorationType: vscode.DecorationRenderOptions = {
            isWholeLine: true,
            dark: {
                backgroundColor: configuration.coverageMissColorDarkMode,
                overviewRulerColor: configuration.coverageMissColorDarkMode,
            },
            light: {
                backgroundColor: configuration.coverageMissColorLightMode,
                overviewRulerColor: configuration.coverageMissColorLightMode,
            },
        };
        return { hit: hitDecorationType, miss: missDecorationType };
    }

    /**
     * Toggle display of coverage results
     */
    toggleDisplayResults() {
        if (this.displayResults === true) {
            this.displayResults = false;
            if (this.currentEditor) {
                this.clear(this.currentEditor);
            } else {
                this.updateCoverageStatusItemText(this.statusItemCoverageOffText());
            }
        } else {
            this.displayResults = true;
            if (this.currentEditor) {
                this.render(this.currentEditor);
            } else {
                this.updateCoverageStatusItemText(this.statusItemCoverageOffText());
            }
        }
    }

    private resultsChanged(results: LcovResults) {
        if (results.folderContext === this.workspaceContext.currentFolder && this.currentEditor) {
            this.render(this.currentEditor);
        }
    }

    private render(editor: vscode.TextEditor) {
        // clear previous results
        this.clear(editor);

        const folder = this.workspaceContext.currentFolder;
        if (!folder || !this.displayResults) {
            return;
        }

        if (!folder.lcovResults.exist) {
            vscode.window.showInformationMessage("Test coverage results are unavailable.");
            this.displayResults = false;
        }

        const results = folder.lcovResults.resultsForFile(editor?.document.fileName);
        if (!results) {
            return;
        }
        const hits = results.lines.details.filter(line => line.hit > 0);
        const misses = results.lines.details.filter(line => line.hit === 0);
        if (hits.length > 0) {
            const ranges = hits.map(line => {
                return new vscode.Range(
                    new vscode.Position(line.line - 1, 0),
                    new vscode.Position(line.line - 1, 0)
                );
            });
            const combinedRanges = this.combineRanges(ranges);
            editor.setDecorations(this.coverageHitDecorationType, combinedRanges);
        }
        if (misses.length > 0) {
            const ranges = misses.map(line => {
                return new vscode.Range(
                    new vscode.Position(line.line - 1, 0),
                    new vscode.Position(line.line - 1, 0)
                );
            });
            const combinedRanges = this.combineRanges(ranges);
            editor.setDecorations(this.coverageMissDecorationType, combinedRanges);
        }

        const coveragePercentage = (100.0 * results.lines.hit) / results.lines.found;
        this.updateCoverageStatusItemText(`Coverage: ${coveragePercentage.toFixed(1)}%`);
        this.statusBarItem.show();
    }

    /**
     * Combine any ranges that are next to each other
     * @param ranges List of ranges
     * @returns Combined ranges
     */
    combineRanges(ranges: vscode.Range[]): vscode.Range[] {
        let lastRange = ranges[0];
        const combinedRanges: vscode.Range[] = [];
        // if ranges length is less than 2 there aren't any ranges to combine
        if (ranges.length < 2) {
            return ranges;
        }
        for (let i = 1; i < ranges.length; i++) {
            if (ranges[i].start.line === lastRange.end.line + 1) {
                lastRange = new vscode.Range(
                    new vscode.Position(lastRange.start.line, 0),
                    new vscode.Position(ranges[i].end.line, 0)
                );
            } else {
                combinedRanges.push(lastRange);
                lastRange = ranges[i];
            }
        }
        combinedRanges.push(lastRange);
        return combinedRanges;
    }

    private clear(editor: vscode.TextEditor) {
        editor.setDecorations(this.coverageHitDecorationType, []);
        editor.setDecorations(this.coverageMissDecorationType, []);
        if (configuration.alwaysShowCoverageStatusItem) {
            this.updateCoverageStatusItemText(this.statusItemCoverageOffText());
        } else {
            this.statusBarItem.hide();
        }
    }

    private statusItemCoverageOffText(): string {
        if (this.displayResults) {
            return "Coverage: Unavailable";
        } else {
            return "Coverage: Off";
        }
    }
}
