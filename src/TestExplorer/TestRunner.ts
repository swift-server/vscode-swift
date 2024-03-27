//===----------------------------------------------------------------------===//
//
// This source file is part of the VSCode Swift open source project
//
// Copyright (c) 2021-2024 the VSCode Swift project authors
// Licensed under Apache License v2.0
//
// See LICENSE.txt for license information
// See CONTRIBUTORS.txt for the list of VSCode Swift project authors
//
// SPDX-License-Identifier: Apache-2.0
//
//===----------------------------------------------------------------------===//

import * as vscode from "vscode";
import * as path from "path";
import * as stream from "stream";
import * as cp from "child_process";
import * as asyncfs from "fs/promises";
import { createTestConfiguration, createDarwinTestConfiguration } from "../debugger/launch";
import { FolderContext } from "../FolderContext";
import { execFileStreamOutput, getErrorDescription } from "../utilities/utilities";
import { getBuildAllTask } from "../SwiftTaskProvider";
import configuration from "../configuration";
import { WorkspaceContext } from "../WorkspaceContext";
import {
    darwinTestRegex,
    iTestRunState,
    nonDarwinTestRegex,
    TestOutputParser,
    TestRegex,
} from "./TestOutputParser";
import { Version } from "../utilities/version";
import { LoggingDebugAdapterTracker } from "../debugger/logTracker";
import { TaskOperation } from "../TaskQueue";
import { TestXUnitParser, iXUnitTestState } from "./TestXUnitParser";

/** Workspace Folder events */
export enum TestKind {
    // run tests serially
    standard = "standard",
    // run tests in parallel
    parallel = "parallel",
    // run tests and extract test coverage
    coverage = "coverage",
}

/** Class used to run tests */
export class TestRunner {
    private testRun: vscode.TestRun;
    private testItems: vscode.TestItem[];
    private testArgs: string[];
    private testOutputParser: TestOutputParser;

    /**
     * Constructor for TestRunner
     * @param request Test run request
     * @param folderContext Folder tests are being run in
     * @param controller Test controller
     */
    constructor(
        private request: vscode.TestRunRequest,
        private folderContext: FolderContext,
        private controller: vscode.TestController
    ) {
        this.testRun = this.controller.createTestRun(this.request);
        const lists = this.createTestLists();
        this.testItems = lists.testItems;
        this.testArgs = lists.testArgs;
        this.testOutputParser = new TestOutputParser();
    }

    get workspaceContext(): WorkspaceContext {
        return this.folderContext.workspaceContext;
    }

    /**
     * Setup debug and run test profiles
     * @param controller Test controller
     * @param folderContext Folder tests are running in
     */
    static setupProfiles(controller: vscode.TestController, folderContext: FolderContext) {
        // Add non-debug profile
        controller.createRunProfile(
            "Run Tests",
            vscode.TestRunProfileKind.Run,
            async (request, token) => {
                const runner = new TestRunner(request, folderContext, controller);
                await runner.runHandler(false, TestKind.standard, token);
            },
            true
        );
        // Add non-debug profile
        controller.createRunProfile(
            "Run Tests (Parallel)",
            vscode.TestRunProfileKind.Run,
            async (request, token) => {
                const runner = new TestRunner(request, folderContext, controller);
                await runner.runHandler(false, TestKind.parallel, token);
            }
        );
        // Add coverage profile
        controller.createRunProfile(
            "Test Coverage",
            vscode.TestRunProfileKind.Run,
            async (request, token) => {
                const runner = new TestRunner(request, folderContext, controller);
                await runner.runHandler(false, TestKind.coverage, token);
            }
        );
        // Add debug profile
        controller.createRunProfile(
            "Debug Tests",
            vscode.TestRunProfileKind.Debug,
            async (request, token) => {
                const runner = new TestRunner(request, folderContext, controller);
                await runner.runHandler(true, TestKind.standard, token);
            }
        );
    }

    /** Construct test item list from TestRequest
     * @returns list of test items to run and list of test for XCTest arguments
     */
    createTestLists(): { testItems: vscode.TestItem[]; testArgs: string[] } {
        const queue: vscode.TestItem[] = [];

        // Loop through all included tests, or all known tests, and add them to our queue
        if (this.request.include && this.request.include.length > 0) {
            this.request.include.forEach(test => queue.push(test));
        } else {
            this.controller.items.forEach(test => queue.push(test));
        }

        // create test list
        const list: vscode.TestItem[] = [];
        const queue2: vscode.TestItem[] = [];
        while (queue.length > 0) {
            const test = queue.pop()!;

            // Skip tests the user asked to exclude
            if (this.request.exclude?.includes(test)) {
                continue;
            }

            // is this a test item for a TestCase class, it has one parent
            // (module and controller)
            if (test.parent && !test.parent?.parent) {
                // if this test item doesn't include an excluded test add the
                // test item to the list and then add its children to the queue2
                // list to be processed in the next loop
                if (
                    !this.request.exclude?.find(item => {
                        return item.id.startsWith(test.id);
                    })
                ) {
                    list.push(test);
                    if (test.children.size > 0) {
                        test.children.forEach(test => queue2.push(test));
                    }
                    continue;
                }
            }

            if (test.children.size > 0) {
                test.children.forEach(test => queue.push(test));
                continue;
            }
            list.push(test);
        }
        // construct list of arguments from test item list ids
        let argumentList: string[] = [];
        // if test list has been filtered in some way then construct list of tests
        // for XCTest arguments
        if (
            (this.request.include && this.request.include.length > 0) ||
            (this.request.exclude && this.request.exclude.length > 0)
        ) {
            argumentList = list.map(item => item.id);
        }

        // add leaf test items, not added in previous loop. A full set of test
        // items being tested is needed when parsing the test output
        while (queue2.length > 0) {
            const test = queue2.pop()!;

            // Skip tests the user asked to exclude
            if (this.request.exclude?.includes(test)) {
                continue;
            }

            list.push(test);
        }
        return { testItems: list, testArgs: argumentList };
    }

    /**
     * Test run handler. Run a series of tests and extracts the results from the output
     * @param shouldDebug Should we run the debugger
     * @param token Cancellation token
     * @returns When complete
     */
    async runHandler(shouldDebug: boolean, testKind: TestKind, token: vscode.CancellationToken) {
        const runState = new TestRunnerTestRunState(this.testItemFinder, this.testRun);
        try {
            // run associated build task
            // don't do this if generating code test coverage data as it
            // will rebuild everything again
            if (testKind !== TestKind.coverage) {
                const task = await getBuildAllTask(this.folderContext);
                const exitCode = await this.folderContext.taskQueue.queueOperation(
                    new TaskOperation(task),
                    token
                );

                // if build failed then exit
                if (exitCode === undefined || exitCode !== 0) {
                    this.testRun.end();
                    return;
                }
            }
            this.setTestsEnqueued();

            if (shouldDebug) {
                await this.debugSession(token, runState);
            } else {
                await this.runSession(token, testKind, runState);
            }
        } catch (error) {
            this.testRun.appendOutput(`\r\nError: ${getErrorDescription(error)}`);
        }

        this.testRun.end();
    }

    /**
     * Edit launch configuration to run tests
     * @param debugging Do we need this configuration for debugging
     * @param outputFile Debug output file
     * @returns
     */
    private createLaunchConfigurationForTesting(
        debugging: boolean
    ): vscode.DebugConfiguration | null {
        const testList = this.testArgs.join(",");

        if (process.platform === "darwin") {
            // if debugging on macOS with Swift 5.6 we need to create a custom launch
            // configuration so we can set the system architecture
            const swiftVersion = this.workspaceContext.toolchain.swiftVersion;
            if (
                debugging &&
                swiftVersion.isLessThan(new Version(5, 7, 0)) &&
                swiftVersion.isGreaterThanOrEqual(new Version(5, 6, 0))
            ) {
                let testFilterArg: string;
                if (testList.length > 0) {
                    testFilterArg = `-XCTest ${testList}`;
                } else {
                    testFilterArg = "";
                }
                const testBuildConfig = createDarwinTestConfiguration(
                    this.folderContext,
                    testFilterArg
                );
                if (testBuildConfig === null) {
                    return null;
                }
                return testBuildConfig;
            } else {
                const testBuildConfig = createTestConfiguration(this.folderContext, true);
                if (testBuildConfig === null) {
                    return null;
                }

                if (testList.length > 0) {
                    testBuildConfig.args = ["-XCTest", testList, ...testBuildConfig.args];
                }
                // output test logging to debug console so we can catch it with a tracker
                testBuildConfig.terminal = "console";
                return testBuildConfig;
            }
        } else {
            const testBuildConfig = createTestConfiguration(this.folderContext, true);
            if (testBuildConfig === null) {
                return null;
            }

            if (testList.length > 0) {
                testBuildConfig.args = [testList];
            }
            // output test logging to debug console so we can catch it with a tracker
            testBuildConfig.terminal = "console";
            return testBuildConfig;
        }
    }

    /** Run test session without attaching to a debugger */
    async runSession(
        token: vscode.CancellationToken,
        testKind: TestKind,
        runState: TestRunnerTestRunState
    ) {
        // create launch config for testing
        const testBuildConfig = this.createLaunchConfigurationForTesting(false);
        if (testBuildConfig === null) {
            return;
        }
        const testRegex = this.testRegex;
        // Parse output from stream and output to log
        const parsedOutputStream = new stream.Writable({
            write: (chunk, encoding, next) => {
                const text = chunk.toString();
                this.testRun.appendOutput(text.replace(/\n/g, "\r\n"));
                this.testOutputParser.parseResult(text, runState, testRegex);
                next();
            },
        });

        // Output test from stream
        const outputStream = new stream.Writable({
            write: (chunk, encoding, next) => {
                const text = chunk.toString();
                this.testRun.appendOutput(text.replace(/\n/g, "\r\n"));
                next();
            },
        });

        if (token.isCancellationRequested) {
            parsedOutputStream.end();
            outputStream.end();
            return;
        }

        this.testRun.appendOutput(`> Test run started at ${new Date().toLocaleString()} <\r\n\r\n`);
        try {
            switch (testKind) {
                case TestKind.coverage:
                    await this.runCoverageSession(
                        token,
                        parsedOutputStream,
                        outputStream,
                        testBuildConfig
                    );
                    break;
                case TestKind.parallel:
                    await this.runParallelSession(
                        token,
                        parsedOutputStream,
                        outputStream,
                        testBuildConfig
                    );
                    break;
                default:
                    await this.runStandardSession(
                        token,
                        parsedOutputStream,
                        outputStream,
                        testBuildConfig
                    );
                    break;
            }
            outputStream.end();
            parsedOutputStream.end();
        } catch (error) {
            outputStream.end();
            parsedOutputStream.end();
            const execError = error as cp.ExecFileException;
            if (execError.code === 1 && execError.killed === false) {
                // Process returned an error code probably because a test failed
            } else if (execError.killed === true) {
                // Process was killed
                this.testRun.appendOutput(`\r\nProcess killed.`);
                return;
            } else if (execError.signal === "SIGILL") {
                // Process crashed
                this.testRun.appendOutput(`\r\nProcess crashed.`);
                if (runState.currentTestItem) {
                    // get last line of error message, which should include why it crashed
                    const errorMessagesLines = execError.message.match(/[^\r\n]+/g);
                    if (errorMessagesLines) {
                        const message = new vscode.TestMessage(
                            getErrorDescription(errorMessagesLines[errorMessagesLines.length - 1])
                        );
                        this.testRun.errored(runState.currentTestItem, message);
                    } else {
                        const message = new vscode.TestMessage(
                            getErrorDescription(execError.message)
                        );
                        this.testRun.errored(runState.currentTestItem, message);
                    }
                }
                return;
            } else {
                // Unrecognised error
                this.testRun.appendOutput(`\r\nError: ${getErrorDescription(error)}`);
                return;
            }
        }
    }

    /** Run tests outside of debugger */
    async runStandardSession(
        token: vscode.CancellationToken,
        parsedOutputStream: stream.Writable,
        outputStream: stream.Writable,
        testBuildConfig: vscode.DebugConfiguration
    ) {
        // Darwin outputs XCTest output to stderr, Linux outputs XCTest output to stdout
        let stdout: stream.Writable;
        let stderr: stream.Writable;
        if (process.platform === "darwin") {
            stdout = outputStream;
            stderr = parsedOutputStream;
        } else {
            stdout = parsedOutputStream;
            stderr = outputStream;
        }

        await execFileStreamOutput(
            testBuildConfig.program,
            testBuildConfig.args ?? [],
            stdout,
            stderr,
            token,
            {
                cwd: testBuildConfig.cwd,
                env: { ...process.env, ...testBuildConfig.env },
                maxBuffer: 16 * 1024 * 1024,
            },
            this.folderContext,
            false,
            "SIGKILL"
        );
    }

    /** Run tests with code coverage, and parse coverage results */
    async runCoverageSession(
        token: vscode.CancellationToken,
        stdout: stream.Writable,
        stderr: stream.Writable,
        testBuildConfig: vscode.DebugConfiguration
    ) {
        try {
            const filterArgs = this.testArgs.flatMap(arg => ["--filter", arg]);
            const args = ["test", "--enable-code-coverage"];
            await execFileStreamOutput(
                this.workspaceContext.toolchain.getToolchainExecutable("swift"),
                [...args, ...filterArgs],
                stdout,
                stderr,
                token,
                {
                    cwd: testBuildConfig.cwd,
                    env: { ...process.env, ...testBuildConfig.env },
                    maxBuffer: 16 * 1024 * 1024,
                },
                this.folderContext,
                false,
                "SIGINT" // use SIGINT to kill process as it is a child process of `swift test`
            );
        } catch (error) {
            const execError = error as cp.ExecFileException;
            if (execError.code !== 1 || execError.killed === true) {
                throw error;
            }
        }
        await this.folderContext.lcovResults.generate();
        if (configuration.displayCoverageReportAfterRun) {
            this.workspaceContext.testCoverageDocumentProvider.show(this.folderContext);
        }
    }

    /** Run tests in parallel outside of debugger */
    async runParallelSession(
        token: vscode.CancellationToken,
        stdout: stream.Writable,
        stderr: stream.Writable,
        testBuildConfig: vscode.DebugConfiguration
    ) {
        await this.workspaceContext.tempFolder.withTemporaryFile("xml", async filename => {
            const sanitizer = this.workspaceContext.toolchain.sanitizer(configuration.sanitizer);
            const sanitizerArgs = sanitizer?.buildFlags ?? [];
            const filterArgs = this.testArgs.flatMap(arg => ["--filter", arg]);
            const args = [
                "test",
                "--parallel",
                ...sanitizerArgs,
                "--skip-build",
                "--xunit-output",
                filename,
            ];
            try {
                await execFileStreamOutput(
                    this.workspaceContext.toolchain.getToolchainExecutable("swift"),
                    [...args, ...filterArgs],
                    stdout,
                    stderr,
                    token,
                    {
                        cwd: testBuildConfig.cwd,
                        env: { ...process.env, ...testBuildConfig.env },
                        maxBuffer: 16 * 1024 * 1024,
                    },
                    this.folderContext,
                    false,
                    "SIGINT" // use SIGINT to kill process as it is a child process of `swift test`
                );
            } catch (error) {
                const execError = error as cp.ExecFileException;
                if (execError.code !== 1 || execError.killed === true) {
                    throw error;
                }
            }
            const buffer = await asyncfs.readFile(filename, "utf8");
            const xUnitParser = new TestXUnitParser();
            const results = await xUnitParser.parse(
                buffer,
                new TestRunnerXUnitTestState(this.testItemFinder, this.testRun)
            );
            if (results) {
                this.testRun.appendOutput(
                    `\r\nExecuted ${results.tests} tests, with ${results.failures} failures and ${results.errors} errors.\r\n`
                );
            }
        });
    }

    /** Run test session inside debugger */
    async debugSession(token: vscode.CancellationToken, runState: TestRunnerTestRunState) {
        // create launch config for testing
        const testBuildConfig = this.createLaunchConfigurationForTesting(true);
        if (testBuildConfig === null) {
            return;
        }

        // given we have already run a build task there is no need to have a pre launch task
        // to build the tests
        testBuildConfig.preLaunchTask = undefined;

        // output test build configuration
        if (configuration.diagnostics) {
            const configJSON = JSON.stringify(testBuildConfig);
            this.workspaceContext.outputChannel.logDiagnostic(
                `Debug Config: ${configJSON}`,
                this.folderContext.name
            );
        }

        const testRegex = this.testRegex;
        const subscriptions: vscode.Disposable[] = [];
        // add cancelation
        const startSession = vscode.debug.onDidStartDebugSession(session => {
            this.workspaceContext.outputChannel.logDiagnostic(
                "Start Test Debugging",
                this.folderContext.name
            );
            LoggingDebugAdapterTracker.setDebugSessionCallback(session, output => {
                this.testRun.appendOutput(output);
                this.testOutputParser.parseResult(output, runState, testRegex);
            });
            const cancellation = token.onCancellationRequested(() => {
                this.workspaceContext.outputChannel.logDiagnostic(
                    "Test Debugging Cancelled",
                    this.folderContext.name
                );
                vscode.debug.stopDebugging(session);
            });
            subscriptions.push(cancellation);
        });
        subscriptions.push(startSession);

        return new Promise<void>((resolve, reject) => {
            vscode.debug.startDebugging(this.folderContext.workspaceFolder, testBuildConfig).then(
                started => {
                    if (started) {
                        this.testRun.appendOutput(
                            `> Test run started at ${new Date().toLocaleString()} <\r\n\r\n`
                        );
                        // show test results pane
                        vscode.commands.executeCommand("testing.showMostRecentOutput");

                        const terminateSession = vscode.debug.onDidTerminateDebugSession(
                            async () => {
                                this.workspaceContext.outputChannel.logDiagnostic(
                                    "Stop Test Debugging",
                                    this.folderContext.name
                                );
                                // dispose terminate debug handler
                                subscriptions.forEach(sub => sub.dispose());
                                resolve();
                            }
                        );
                        subscriptions.push(terminateSession);
                    } else {
                        subscriptions.forEach(sub => sub.dispose());
                        reject();
                    }
                },
                reason => {
                    subscriptions.forEach(sub => sub.dispose());
                    reject(reason);
                }
            );
        });
    }

    setTestsEnqueued() {
        for (const test of this.testItems) {
            this.testRun.enqueued(test);
        }
    }

    /** Get TestItem finder for current platform */
    get testItemFinder(): TestItemFinder {
        if (process.platform === "darwin") {
            return new DarwinTestItemFinder(this.testItems);
        } else {
            return new NonDarwinTestItemFinder(this.testItems, this.folderContext);
        }
    }

    /** Get Test parsing regex for current platform */
    get testRegex(): TestRegex {
        if (process.platform === "darwin") {
            return darwinTestRegex;
        } else {
            return nonDarwinTestRegex;
        }
    }
}

/** Interface defining how to find test items given a test id from XCTest output */
interface TestItemFinder {
    getIndex(id: string, filename?: string): number;
    testItems: vscode.TestItem[];
}

/** Defines how to find test items given a test id from XCTest output on Darwin platforms */
class DarwinTestItemFinder implements TestItemFinder {
    constructor(public testItems: vscode.TestItem[]) {}

    getIndex(id: string): number {
        return this.testItems.findIndex(item => item.id === id);
    }
}

/** Defines how to find test items given a test id from XCTest output on non-Darwin platforms */
class NonDarwinTestItemFinder implements TestItemFinder {
    constructor(
        public testItems: vscode.TestItem[],
        public folderContext: FolderContext
    ) {}

    /**
     * Get test item index from id for non Darwin platforms. It is a little harder to
     * be certain we have the correct test item on non Darwin platforms as the target
     * name is not included in the id
     */
    getIndex(id: string, filename?: string): number {
        let testIndex = -1;
        if (filename) {
            testIndex = this.testItems.findIndex(item =>
                this.isTestWithFilenameInTarget(id, filename, item)
            );
        }
        if (testIndex === -1) {
            testIndex = this.testItems.findIndex(item => item.id.endsWith(id));
        }
        return testIndex;
    }

    /**
     * Linux test output does not include the target name. So I have to work out which target
     * the test is in via the test name and if it failed the filename from the error. In theory
     * if a test fails the filename for where it failed should indicate which target it is in.
     *
     * @param testName Test name
     * @param filename File name of where test failed
     * @param item TestItem
     * @returns Is it this TestItem
     */
    private isTestWithFilenameInTarget(
        testName: string,
        filename: string,
        item: vscode.TestItem
    ): boolean {
        if (!item.id.endsWith(testName)) {
            return false;
        }
        // get target test item
        const targetTestItem = item.parent?.parent;
        if (!targetTestItem) {
            return false;
        }
        // get target from Package
        const target = this.folderContext.swiftPackage.targets.find(
            item => targetTestItem.label === item.name
        );
        if (target) {
            const fileErrorIsIn = filename;
            const targetPath = path.join(this.folderContext.folder.fsPath, target.path);
            const relativePath = path.relative(targetPath, fileErrorIsIn);
            return target.sources.find(source => source === relativePath) !== undefined;
        }
        return false;
    }
}

/**
 * Store state of current test run output parse
 */
class TestRunnerTestRunState implements iTestRunState {
    constructor(
        private testItemFinder: TestItemFinder,
        private testRun: vscode.TestRun
    ) {}

    public currentTestItem?: vscode.TestItem;
    public lastTestItem?: vscode.TestItem;
    public excess?: string;
    public failedTest?: {
        testIndex: number;
        message: string;
        file: string;
        lineNumber: number;
        complete: boolean;
    };

    getTestItemIndex(id: string, filename?: string): number {
        return this.testItemFinder.getIndex(id, filename);
    }

    // set test item to be started
    started(index: number): void {
        this.testRun.started(this.testItemFinder.testItems[index]);
        this.currentTestItem = this.testItemFinder.testItems[index];
    }

    // set test item to have passed
    passed(index: number, duration: number): void {
        this.testRun.passed(this.testItemFinder.testItems[index], duration * 1000);
        this.testItemFinder.testItems.splice(index, 1);
        this.lastTestItem = this.currentTestItem;
        this.currentTestItem = undefined;
    }

    // set test item to be failed
    failed(index: number, message: string, location?: { file: string; line: number }): void {
        if (location) {
            const testMessage = new vscode.TestMessage(message);
            testMessage.location = new vscode.Location(
                vscode.Uri.file(location.file),
                new vscode.Position(location.line - 1, 0)
            );
            this.testRun.failed(this.testItemFinder.testItems[index], testMessage);
        } else {
            this.testRun.failed(
                this.testItemFinder.testItems[index],
                new vscode.TestMessage(message)
            );
        }
        this.testItemFinder.testItems.splice(index, 1);
        this.lastTestItem = this.currentTestItem;
        this.currentTestItem = undefined;
    }

    // set test item to have been skipped
    skipped(index: number): void {
        this.testRun.skipped(this.testItemFinder.testItems[index]);
        this.testItemFinder.testItems.splice(index, 1);
        this.lastTestItem = this.currentTestItem;
        this.currentTestItem = undefined;
    }

    // started suite
    startedSuite() {
        // Nothing to do here
    }
    // passed suite
    passedSuite(name: string) {
        const lastClassTestItem = this.lastTestItem?.parent;
        if (lastClassTestItem && lastClassTestItem.id.endsWith(`.${name}`)) {
            this.testRun.passed(lastClassTestItem);
        }
    }
    // failed suite
    failedSuite(name: string) {
        const lastClassTestItem = this.lastTestItem?.parent;
        if (lastClassTestItem && lastClassTestItem.id.endsWith(`.${name}`)) {
            this.testRun.failed(lastClassTestItem, []);
        }
    }
}

class TestRunnerXUnitTestState implements iXUnitTestState {
    constructor(
        private testItemFinder: TestItemFinder,
        private testRun: vscode.TestRun
    ) {}

    passTest(id: string, duration: number): void {
        const index = this.testItemFinder.getIndex(id);
        if (index !== -1) {
            this.testRun.passed(this.testItemFinder.testItems[index], duration);
        }
    }
    failTest(id: string, duration: number, message?: string): void {
        const index = this.testItemFinder.getIndex(id);
        if (index !== -1) {
            const testMessage = new vscode.TestMessage(message ?? "Failed");
            this.testRun.failed(this.testItemFinder.testItems[index], testMessage, duration);
        }
    }
    skipTest(id: string): void {
        const index = this.testItemFinder.getIndex(id);
        if (index !== -1) {
            this.testRun.skipped(this.testItemFinder.testItems[index]);
        }
    }
}
