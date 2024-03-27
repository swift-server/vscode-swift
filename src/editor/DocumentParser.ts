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

/**
 * Parse VSCode TextDocuments using regular expressions.
 * Inspiration for this code came from https://github.com/fappelman/swift-add-documentation
 */
export class DocumentParser {
    constructor(
        readonly document: vscode.TextDocument,
        private position: vscode.Position
    ) {}

    /**
     * Match regular expression at current position in document. Move position to just
     * after the match
     * @param expression Regular expression
     * @returns returns groups matched
     */
    match(expression: RegExp): string[] | null {
        const text = this.getLine();
        if (!text) {
            return null;
        }
        // match expression
        const result = expression.exec(text.text);
        if (result) {
            const offset = result.index + result[0].length;
            this.position = this.position.translate(undefined, offset + text.whitespace);

            const results = result.map(match => match);
            results.shift();
            return results;
        }
        return null;
    }

    /**
     * Skip through document lines until you hit a character. Don't return when inside delimiters "({[<"
     * @param characters skip until you find one of these characters
     * @returns character you hit
     */
    skipUntil(characters: string): string | undefined {
        const openDelimiters = '{([<"';
        const closeDelimiters = '})]>"';
        // list of delimiters that if you reach and were not expect then the swift code is not valid
        // this does not include `>` because you can find this in `->`.
        const closeDelimitersFailure = "})]";
        const stack: string[] = [];
        for (let text = this.getLine(); text; text = this.getLine()) {
            let delimiterIndex = -1;
            let index = 0;
            while (index < text.text.length) {
                const character = text.text[index];
                // is this one of the expected characters
                if (characters.indexOf(character) !== -1) {
                    // pop previous expected characters off stack and if there isn't one then
                    // we have found the character we were looking for. Set the position and return
                    const value = stack.pop();
                    if (!value) {
                        this.position = this.position.translate(
                            undefined,
                            index + text.whitespace + 1
                        );
                        return text.text[index];
                    }
                    characters = value;
                }
                // is this an open delimiter character
                else if ((delimiterIndex = openDelimiters.indexOf(character)) !== -1) {
                    stack.push(characters);
                    characters = closeDelimiters[delimiterIndex];
                }
                // if you find a close delimiter then we got the wrong delimiter and should fail
                else if (closeDelimitersFailure.indexOf(character) !== -1 && characters !== '"') {
                    return undefined;
                } else if (character === "\\" && characters === '"') {
                    index += 1;
                }
                index += 1;
            }
            this.position = this.position.translate(1, -this.position.character);
        }
        return undefined;
    }

    /**
     * Get line, skipping whitespace
     * @returns return text, whitespace skipped
     */
    private getLine(): { text: string; whitespace: number } | null {
        while (this.position.line < this.document.lineCount) {
            const line = this.document.lineAt(this.position.line).text;
            const remainsOfLine = line.substring(this.position.character);
            // skip whitespace
            const whitespace = /^\s*/.exec(remainsOfLine);
            let whitespaceCount = 0;
            if (whitespace) {
                whitespaceCount = whitespace[0].length;
            }
            if (remainsOfLine.length > whitespaceCount) {
                return {
                    text: remainsOfLine.substring(whitespaceCount),
                    whitespace: whitespaceCount,
                };
            }
            this.position = this.position.translate(1, -this.position.character);
        }
        return null;
    }
}
