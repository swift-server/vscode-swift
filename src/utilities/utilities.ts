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

import * as cp from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as plist from "plist";
import * as vscode from "vscode";
import configuration from "../configuration";
import { FolderContext } from "../FolderContext";
import { Version } from "./version";

/**
 * Asynchronous wrapper around {@link cp.exec child_process.exec}.
 *
 * Commands will be executed by the user's `$SHELL`, if configured.
 */
export async function exec(
    command: string,
    options: cp.ExecOptions
): Promise<{ stdout: string; stderr: string }> {
    options.shell = process.env.SHELL;
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) =>
        cp.exec(command, options, (error, stdout, stderr) => {
            if (error) {
                reject({ error, stdout, stderr });
            }
            resolve({ stdout, stderr });
        })
    );
}

/**
 * Asynchronous wrapper around {@link cp.execFile child_process.execFile}.
 *
 * Assumes output will be a string
 *
 * @param executable name of executable to run
 * @param args arguments to be passed to executable
 * @param options execution options
 */
export async function execFile(
    executable: string,
    args: string[],
    options: cp.ExecFileOptions = {}
): Promise<{ stdout: string; stderr: string }> {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) =>
        cp.execFile(executable, args, options, (error, stdout, stderr) => {
            if (error) {
                reject({ error, stdout, stderr });
            }
            resolve({ stdout, stderr });
        })
    );
}

/**
 * Asynchronous wrapper around {@link cp.execFile child_process.execFile} running
 * swift executable
 *
 * @param args array of arguments to pass to swift executable
 * @param options execution options
 */
export async function execSwift(
    args: string[],
    options: cp.ExecFileOptions = {}
): Promise<{ stdout: string; stderr: string }> {
    const swift = getSwiftExecutable();
    return await execFile(swift, args, options);
}

/**
 * Get path to swift executable, or executable in swift bin folder
 *
 * @param exe name of executable to return
 */
export function getSwiftExecutable(exe = "swift"): string {
    return path.join(configuration.path, exe);
}

/**
 * Extracts the base name of a repository from its URL.
 *
 * The base name is the last path component of the URL, without the extension `.git`,
 * and without an optional trailing slash.
 */
export function getRepositoryName(url: string): string {
    // This regular expression consists of:
    // - any number of characters that aren't a slash: ([^/]*)
    // - optionally followed by a trailing slash: \/?
    // - at the end of the URL: $
    const pattern = /([^/]*)\/?$/;
    // The capture group in this pattern will match the last path component of the URL.
    let lastPathComponent = url.match(pattern)![1];
    // Trim the optional .git extension.
    if (lastPathComponent.endsWith(".git")) {
        lastPathComponent = lastPathComponent.replace(/\.git$/, "");
    }
    return lastPathComponent;
}

/**
 * Whether the given path exists.
 *
 * Does not check whether the user has permission to read the path.
 */
export async function pathExists(...pathComponents: string[]): Promise<boolean> {
    try {
        await fs.access(path.join(...pathComponents));
        return true;
    } catch {
        return false;
    }
}

/**
 * Return whether a file is inside a folder
 * @param subfolder child file/folder
 * @param folder parent folder
 * @returns if child file is inside parent folder
 */
export function isPathInsidePath(subfolder: string, folder: string): boolean {
    const relativePath = path.relative(folder, subfolder);
    // return true if path doesnt start with '..'
    return relativePath[0] !== "." || relativePath[1] !== ".";
}

/**
 * @returns path to Xcode developer folder
 */
export async function getXcodePath(): Promise<string | undefined> {
    try {
        const { stdout } = await execFile("xcode-select", ["-p"]);
        return stdout.trimEnd();
    } catch {
        return undefined;
    }
}

/**
 * Contents of **Info.plist** on Windows.
 */
interface InfoPlist {
    DefaultProperties: {
        XCTEST_VERSION: string | undefined;
    };
}

/**
 * Finds and returns the path to **XCTest.dll** on Windows.
 *
 * @throws when unable to find this path.
 */
export async function getXCTestPath(): Promise<string> {
    const developerPath = process.env.DEVELOPER_DIR;
    if (!developerPath) {
        throw Error("Environment variable DEVELOPER_DIR is not set.");
    }
    const platformPath = path.join(developerPath, "Platforms", "Windows.platform");
    const data = await fs.readFile(path.join(platformPath, "Info.plist"), "utf8");
    const infoPlist = plist.parse(data) as unknown as InfoPlist;
    const version = infoPlist.DefaultProperties.XCTEST_VERSION;
    if (!version) {
        throw Error("Info.plist is missing the XCTEST_VERSION key.");
    }
    return path.join(platformPath, "Developer", "Library", `XCTest-${version}`, "usr", "bin");
}

/**
 * @returns SwiftPM flag for enabling test discovery
 */
export async function testDiscoveryFlag(ctx: FolderContext): Promise<string[]> {
    // Test discovery is only available in SwiftPM 5.1 and later.
    if (ctx.workspaceContext.swiftVersion.isLessThan(new Version(5, 1, 0))) {
        return [];
    }
    // Test discovery is always enabled on Darwin.
    if (process.platform !== "darwin" && ctx.swiftPackage.getTargets("test").length > 0) {
        const alwaysDiscoverTests = vscode.workspace
            .getConfiguration("swiftpm")
            .get<boolean>("testDiscovery.always", true);
        const hasLinuxMain = await pathExists(ctx.folder.fsPath, "Tests", "LinuxMain.swift");
        const testDiscoveryByDefault = ctx.workspaceContext.swiftVersion.isGreaterThanOrEqual(
            new Version(5, 4, 0)
        );
        if ((hasLinuxMain && alwaysDiscoverTests) || (!hasLinuxMain && !testDiscoveryByDefault)) {
            return ["--enable-test-discovery"];
        }
    }
    return [];
}
