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

import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { execSwift } from "./utilities";

/** Swift Package Manager contents */
export interface PackageContents {
    name: string;
    products: Product[];
    dependencies: Dependency[];
    targets: Target[];
}

/** Swift Package Manager product */
export interface Product {
    name: string;
    targets: string[];
    type: { executable?: null; library?: string[] };
}

/** Swift Package Manager target */
export interface Target {
    name: string;
    path: string;
    sources: string[];
    type: "executable" | "test" | "library";
}

/** Swift Package Manager dependency */
export interface Dependency {
    identity: string;
    requirement?: object;
    url?: string;
}

/** Swift Package.resolved file */
export interface PackageResolved {
    object: { pins: PackageResolvedPin[] };
    version: number;
}

/** Swift Package.resolved file */
export interface PackageResolvedPin {
    package: string;
    repositoryURL: string;
    state: PackageResolvedPinState;
}

/** Swift Package.resolved file */
export interface PackageResolvedPinState {
    branch: string | null;
    revision: string;
    version: string | null;
}

/**
 * Class holding Swift Package Manager Package
 */
export class SwiftPackage implements PackageContents {
    /**
     * SwiftPackage Constructor
     * @param folder folder package is in
     * @param contents results of `swift package describe`
     * @param resolved contents of Package.resolved
     */
    private constructor(
        readonly folder: vscode.WorkspaceFolder,
        private contents?: PackageContents | null,
        public resolved?: PackageResolved
    ) {}

    /**
     * Create a SwiftPackage from a folder
     * @param folder folder package is in
     * @returns new SwiftPackage
     */
    static async create(folder: vscode.WorkspaceFolder): Promise<SwiftPackage> {
        const contents = await SwiftPackage.loadPackage(folder);
        const resolved = await SwiftPackage.loadPackageResolved(folder);
        return new SwiftPackage(folder, contents, resolved);
    }

    /**
     * Run `swift package describe` and return results
     * @param folder folder package is in
     * @returns results of `swift package describe`
     */
    static async loadPackage(
        folder: vscode.WorkspaceFolder
    ): Promise<PackageContents | null | undefined> {
        try {
            const { stdout } = await execSwift(["package", "describe", "--type", "json"], {
                cwd: folder.uri.fsPath,
            });
            return JSON.parse(stdout);
        } catch (error) {
            const execError = error as { stderr: string };
            // if caught error and it begins with "error: root manifest" then there is no Package.swift
            if (execError.stderr.startsWith("error: root manifest")) {
                return undefined;
            } else {
                // otherwise it is an error loading the Package.swift so return `null` indicating
                // we have a package but we failed to load it
                return null;
            }
        }
    }

    static async loadPackageResolved(
        folder: vscode.WorkspaceFolder
    ): Promise<PackageResolved | undefined> {
        try {
            const resolvedPath = path.join(folder.uri.fsPath, "Package.resolved");
            const data = await fs.readFile(resolvedPath, "utf8");
            return JSON.parse(data);
        } catch {
            // failed to load resolved file return undefined
            return undefined;
        }
    }

    /** Reload swift package */
    public async reload() {
        this.contents = await SwiftPackage.loadPackage(this.folder);
    }

    /** Reload Package.resolved file */
    public async reloadPackageResolved() {
        this.resolved = await SwiftPackage.loadPackageResolved(this.folder);
    }

    /** Return if has valid contents */
    public get isValid(): boolean {
        return this.contents !== null && this.contents !== undefined;
    }

    /** Did we find a Package.swift */
    public get foundPackage(): boolean {
        return this.contents !== undefined;
    }

    /** name of Swift Package */
    get name(): string {
        return this.contents?.name ?? "";
    }

    /** array of products in Swift Package */
    get products(): Product[] {
        return this.contents?.products ?? [];
    }

    /** array of dependencies in Swift Package */
    get dependencies(): Dependency[] {
        return this.contents?.dependencies ?? [];
    }

    /** array of targets in Swift Package */
    get targets(): Target[] {
        return this.contents?.targets ?? [];
    }

    /** array of executable products in Swift Package */
    get executableProducts(): Product[] {
        return this.products.filter(product => product.type.executable !== undefined);
    }

    /** array of library products in Swift Package */
    get libraryProducts(): Product[] {
        return this.products.filter(product => product.type.library !== undefined);
    }

    /**
     * Return array of targets of a certain type
     * @param type Type of target
     * @returns Array of targets
     */
    getTargets(type: "executable" | "library" | "test"): Target[] {
        return this.targets.filter(target => target.type === type);
    }
}
