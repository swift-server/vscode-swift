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
import * as cp from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as Stream from "stream";
import configuration from "../configuration";
import { FolderContext } from "../FolderContext";

export interface ExecError {
    error: Error;
}

/**
 * Get required environment variable for Swift product
 *
 * @param base base environment configuration
 * @returns minimal required environment for Swift product
 */
export function swiftRuntimeEnv(
    base: NodeJS.ProcessEnv | boolean = process.env
): { [key: string]: string } | undefined {
    if (configuration.runtimePath === "") {
        return undefined;
    }
    const runtimePath = configuration.runtimePath;
    const key = swiftLibraryPathKey();
    const separator = process.platform === "win32" ? ";" : ":";
    switch (base) {
        case false:
            return { [key]: runtimePath };
        case true:
            return { [key]: `${runtimePath}${separator}\${env:${key}}` };
        default:
            return base[key]
                ? { [key]: `${runtimePath}${separator}${base[key]}` }
                : { [key]: runtimePath };
    }
}

/** Return environment variable to update for runtime library search path */
export function swiftLibraryPathKey(): string {
    switch (process.platform) {
        case "win32":
            return "Path";
        case "darwin":
            return "DYLD_LIBRARY_PATH";
        default:
            return "LD_LIBRARY_PATH";
    }
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
    options: cp.ExecFileOptions = {},
    folderContext?: FolderContext,
    customSwiftRuntime = true
): Promise<{ stdout: string; stderr: string }> {
    folderContext?.workspaceContext.outputChannel.logDiagnostic(
        `Exec: ${executable} ${args.join(" ")}`,
        folderContext.name
    );
    if (customSwiftRuntime) {
        const runtimeEnv = swiftRuntimeEnv(options.env);
        if (runtimeEnv && Object.keys(runtimeEnv).length > 0) {
            options.env = { ...(options.env ?? process.env), ...runtimeEnv };
        }
    }
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) =>
        cp.execFile(executable, args, options, (error, stdout, stderr) => {
            if (error) {
                reject({ error, stdout, stderr });
            }
            resolve({ stdout, stderr });
        })
    );
}

export async function execFileStreamOutput(
    executable: string,
    args: string[],
    stdout: Stream.Writable | null,
    stderr: Stream.Writable | null,
    token: vscode.CancellationToken | null,
    options: cp.ExecFileOptions = {},
    folderContext?: FolderContext,
    customSwiftRuntime = true
): Promise<void> {
    folderContext?.workspaceContext.outputChannel.logDiagnostic(
        `Exec: ${executable} ${args.join(" ")}`,
        folderContext.name
    );
    if (customSwiftRuntime) {
        const runtimeEnv = swiftRuntimeEnv(options.env);
        if (runtimeEnv && Object.keys(runtimeEnv).length > 0) {
            options.env = { ...(options.env ?? process.env), ...runtimeEnv };
        }
    }
    return new Promise<void>((resolve, reject) => {
        const p = cp.execFile(executable, args, options, error => {
            if (error) {
                reject({ error });
            }
            resolve();
        });
        if (stdout) {
            p.stdout?.pipe(stdout);
        }
        if (stderr) {
            p.stderr?.pipe(stderr);
        }
        if (token) {
            const cancellation = token.onCancellationRequested(() => {
                p.kill();
                cancellation.dispose();
            });
        }
    });
}

/**
 * Asynchronous wrapper around {@link cp.execFile child_process.execFile} running
 * swift executable
 *
 * @param args array of arguments to pass to swift executable
 * @param options execution options
 * @param setSDKFlags whether to set SDK flags
 */
export async function execSwift(
    args: string[],
    options: cp.ExecFileOptions = {},
    folderContext?: FolderContext
): Promise<{ stdout: string; stderr: string }> {
    const swift = getSwiftExecutable();
    args = withSwiftSDKFlags(args);
    if (Object.keys(configuration.swiftEnvironmentVariables).length > 0) {
        // when adding environment vars we either combine with vars passed
        // into the function or the process environment vars
        options.env = {
            ...(options.env ?? process.env),
            ...configuration.swiftEnvironmentVariables,
        };
    }
    return await execFile(swift, args, options, folderContext);
}

/**
 * Get modified swift arguments with SDK flags.
 *
 * @param args original commandline arguments
 */
export function withSwiftSDKFlags(args: string[]): string[] {
    switch (args[0]) {
        case "package": {
            const subcommand = args.splice(0, 2).concat(buildPathFlags());
            switch (subcommand[1]) {
                case "dump-symbol-graph":
                case "diagnose-api-breaking-changes":
                case "resolve": {
                    // These two tools require building the package, so SDK
                    // flags are needed. Destination control flags are
                    // required to be placed before subcommand options.
                    return [...subcommand, ...swiftpmSDKFlags(), ...args];
                }
                default:
                    // Other swift-package subcommands operate on the host,
                    // so it doesn't need to know about the destination.
                    return subcommand.concat(args);
            }
        }
        case "build":
        case "run":
        case "test": {
            const subcommand = args.splice(0, 1).concat(buildPathFlags());
            return [...subcommand, ...swiftpmSDKFlags(), ...args];
        }
        default:
            // We're not going to call the Swift compiler directly for cross-compiling
            // and the destination settings are package-only, so do nothing here.
            return args;
    }
}

/**
 * Get SDK flags for SwiftPM
 */
export function swiftpmSDKFlags(): string[] {
    if (configuration.sdk !== "") {
        return ["--sdk", configuration.sdk];
    }
    return [];
}

/**
 * Get build path flags to be passed to swift package manager and sourcekit-lsp server
 */
export function buildPathFlags(): string[] {
    if (configuration.buildPath && configuration.buildPath.length > 0) {
        return ["--build-path", configuration.buildPath];
    } else {
        return [];
    }
}

/**
 * Get build path from configuration if exists or return a fallback .build directory in given workspace
 * @param filesystem path to workspace that will be used as a fallback loacation with .build directory
 */
export function buildDirectoryFromWorkspacePath(workspacePath: string, absolute = false): string {
    const buildPath = configuration.buildPath.length > 0 ? configuration.buildPath : ".build";
    if (!path.isAbsolute(buildPath) && absolute) {
        return path.join(workspacePath, buildPath);
    } else {
        return buildPath;
    }
}

/**
 * Get SDK flags for swiftc
 *
 * @param indirect whether to pass the flags by -Xswiftc
 */
export function swiftDriverSDKFlags(indirect = false): string[] {
    if (configuration.sdk === "") {
        return [];
    }
    const args = ["-sdk", configuration.sdk];
    return indirect ? args.flatMap(arg => ["-Xswiftc", arg]) : args;
}

/**
 * Get target flags for swiftc
 *
 * @param indirect whether to pass the flags by -Xswiftc
 */
export function swiftDriverTargetFlags(indirect = false): string[] {
    const IPHONE_SDK_KIND = "iPhoneOS";

    let args: string[] = [];

    if (configuration.sdk === "") {
        return args;
    }

    const sdkKindParts = configuration.sdk.split("/");
    const sdkKind = sdkKindParts[sdkKindParts.length - 1];
    if (sdkKind.includes(IPHONE_SDK_KIND)) {
        // Obtain the iOS version of the SDK.
        const version = sdkKind.substring(
            // Trim the prefix
            sdkKind.length - IPHONE_SDK_KIND.length,
            // Trim the `.sdk` suffix
            sdkKind.length - 4
        );
        args = ["-target", `arm64-apple-ios${version}`];
    }

    return indirect ? args.flatMap(arg => ["-Xswiftc", arg]) : args;
}

/**
 * Get the file name of executable
 *
 * @param exe name of executable to return
 */
export function getExecutableName(exe: string): string {
    return process.platform === "win32" ? `${exe}.exe` : exe;
}

/**
 * Get path to swift executable, or executable in swift bin folder
 *
 * @param exe name of executable to return
 */
export function getSwiftExecutable(exe = "swift"): string {
    return path.join(configuration.path, getExecutableName(exe));
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
 * Return random string
 * @param length Length of string to return (max 16)
 * @returns Random string
 */
export function randomString(length = 8): string {
    return Math.random().toString(16).substring(2, length);
}

/**
 * Return string description of Error object
 * @param error Error object
 * @returns String description of error
 */
export function getErrorDescription(error: unknown): string {
    if ((error as { stderr: string }).stderr) {
        return (error as { stderr: string }).stderr;
    } else if ((error as { error: string }).error) {
        return JSON.stringify((error as { error: string }).error);
    } else if (error instanceof Error) {
        return error.message;
    } else {
        return JSON.stringify(error);
    }
}

/**
 * Convert array of strings into phrase eg "a, b and c"
 * @param strings Array of strings
 * @returns phrase
 */
export function stringArrayInEnglish(strings: string[]): string {
    return strings.length === 1
        ? strings[0]
        : [strings.slice(0, -1).join(", "), strings[strings.length - 1]].join(" and ");
}

export interface ArgumentFilter {
    argument: string;
    include: number;
}

/**
 *  Filter argument list
 * @param args argument list
 * @param filter argument list filter
 * @returns filtered argument list
 */
export function filterArguments(args: string[], filter: ArgumentFilter[]): string[] {
    const filteredArguments: string[] = [];
    let includeCount = 0;
    for (const arg of args) {
        if (includeCount > 0) {
            filteredArguments.push(arg);
            includeCount -= 1;
            continue;
        }
        const argFilter = filter.find(item => item.argument === arg);
        if (argFilter) {
            filteredArguments.push(arg);
            includeCount = argFilter.include;
            continue;
        }
        // find arguments of form arg=value
        const argFilter2 = filter.find(
            item => item.include === 1 && arg.startsWith(item.argument + "=")
        );
        if (argFilter2) {
            filteredArguments.push(arg);
        }
    }
    return filteredArguments;
}
