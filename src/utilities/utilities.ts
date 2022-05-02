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
    if (configuration.runtimePath.length > 0 && customSwiftRuntime) {
        options.env = { ...options.env, ...swiftRuntimeEnv(options.env) };
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
): Promise<{ stdout: string; stderr: string }> {
    folderContext?.workspaceContext.outputChannel.logDiagnostic(
        `Exec: ${executable} ${args.join(" ")}`,
        folderContext.name
    );
    if (configuration.runtimePath.length > 0 && customSwiftRuntime) {
        options.env = { ...options.env, ...swiftRuntimeEnv(options.env) };
    }
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const p = cp.execFile(executable, args, options, (error, stdout, stderr) => {
            if (error) {
                reject({ error, stdout, stderr });
            }
            resolve({ stdout, stderr });
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
 * @param setDestinationFlags whether to set destination flags
 */
export async function execSwift(
    args: string[],
    options: cp.ExecFileOptions = {},
    setDestinationFlags = false,
    folderContext?: FolderContext
): Promise<{ stdout: string; stderr: string }> {
    const swift = getSwiftExecutable();
    if (setDestinationFlags) {
        args = withSwiftDestinationFlags(args);
    }
    return await execFile(swift, args, options, folderContext);
}

/**
 * Get modified swift arguments with config-based destination flags.
 *
 * @param args original commandline arguments
 */
export function withSwiftDestinationFlags(args: string[]): string[] {
    switch (args.length > 0 ? args[0] : null) {
        case "package": {
            // swift-package requires destination flags to be placed before arguments
            // eg. ["package", "describe", "--type", "json"] should be turned into
            // ["package", "describe", "--sdk", "/path/to/sdk", "--type", "json"]
            if (args.length <= 2) {
                return args.concat(swiftpmDestinationFlags());
            }
            const subcommand = args.splice(0, 2);
            return [...subcommand, ...swiftpmDestinationFlags(), ...args];
        }
        case "build":
        case "run":
        case "test":
            return args.concat(swiftpmDestinationFlags());
        default:
            return args.concat(swiftDriverDestinationFlags());
    }
}

/**
 * Get destination flags for SwiftPM
 */
export function swiftpmDestinationFlags(): string[] {
    const destination = configuration.destination;
    if (destination.sdk !== "") {
        return ["--sdk", destination.sdk];
    }
    return [];
}

/**
 * Get destination flags for swiftc
 *
 * @param indirect whether to pass the flags by -Xswiftc
 */
export function swiftDriverDestinationFlags(indirect = false): string[] {
    const destination = configuration.destination;
    if (destination.sdk === "") {
        return [];
    }
    const args = ["-sdk", destination.sdk];
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
