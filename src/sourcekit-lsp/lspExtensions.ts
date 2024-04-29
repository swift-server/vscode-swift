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

import * as langclient from "vscode-languageclient/node";

// Definitions for non-standard requests used by sourcekit-lsp

// Inlay Hints (pre Swift 5.6)
export interface LegacyInlayHintsParams {
    /**
     * The text document.
     */
    textDocument: langclient.TextDocumentIdentifier;

    /**
     * If set, the reange for which inlay hints are
     * requested. If unset, hints for the entire document
     * are returned.
     */
    range?: langclient.Range;

    /**
     * The categories of inlay hints that are requested.
     * If unset, all categories are returned.
     */
    only?: string[];
}

export interface LegacyInlayHint {
    /**
     * The position within the code that this hint is
     * attached to.
     */
    position: langclient.Position;

    /**
     * The hint's kind, used for more flexible client-side
     * styling of the hint.
     */
    category?: string;

    /**
     * The hint's rendered label.
     */
    label: string;
}

export const legacyInlayHintsRequest = new langclient.RequestType<
    LegacyInlayHintsParams,
    LegacyInlayHint[],
    unknown
>("sourcekit-lsp/inlayHints");

// Listing tests
//export interface WorkspaceTestsParams {}

export const workspaceTestsRequest = new langclient.RequestType<
    Record<string, never>,
    langclient.SymbolInformation[],
    unknown
>("workspace/tests");
