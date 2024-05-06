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
import * as os from "os";
import * as asyncfs from "fs/promises";
import {
    createXCTestConfiguration,
    createSwiftTestConfiguration,
    createDarwinTestConfiguration,
} from "../debugger/launch";
import { FolderContext } from "../FolderContext";
import { getBuildAllTask } from "../tasks/SwiftTaskProvider";
import { execFile, getErrorDescription, regexEscapedString } from "../utilities/utilities";
import configuration from "../configuration";
import { WorkspaceContext } from "../WorkspaceContext";
import { XCTestOutputParser } from "./TestParsers/XCTestOutputParser";
import { SwiftTestingOutputParser } from "./TestParsers/SwiftTestingOutputParser";
import { Version } from "../utilities/version";
import { LoggingDebugAdapterTracker } from "../debugger/logTracker";
import { TaskOperation } from "../tasks/TaskQueue";
import { TestXUnitParser, iXUnitTestState } from "./TestXUnitParser";
import { ITestRunState } from "./TestParsers/TestRunState";
import { TestRunArguments } from "./TestRunArguments";
import { TemporaryFolder } from "../utilities/tempFolder";
import { TestClass, runnableTag, upsertTestItem } from "./TestDiscovery";
import { SwiftProcess } from "../tasks/SwiftProcess";
import { TestCoverage } from "../coverage/TestCoverage";

/** Workspace Folder events */
export enum TestKind {
    // run tests serially
    standard = "standard",
    // run tests in parallel
    parallel = "parallel",
    // run tests and extract test coverage
    coverage = "coverage",
}

export enum RunProfileName {
    run = "Run Tests",
    runParallel = "Run Tests (Parallel)",
    coverage = "Test Coverage",
    debug = "Debug Tests",
}

export class TestRunProxy {
    private testRun?: vscode.TestRun;
    private addedTestItems: { testClass: TestClass; parentIndex: number }[] = [];
    private runStarted: boolean = false;
    private queuedOutput: string[] = [];
    private _testItems: vscode.TestItem[];
    public coverage: TestCoverage;

    // Allows for introspection on the state of TestItems after a test run.
    public runState = {
        failed: [] as vscode.TestItem[],
        passed: [] as vscode.TestItem[],
        skipped: [] as vscode.TestItem[],
        errored: [] as vscode.TestItem[],
    };

    public get testItems(): vscode.TestItem[] {
        return this._testItems;
    }

    constructor(
        private testRunRequest: vscode.TestRunRequest,
        private controller: vscode.TestController,
        private args: TestRunArguments,
        private folderContext: FolderContext
    ) {
        this._testItems = args.testItems;
        this.coverage = new TestCoverage(folderContext);
    }

    public testRunStarted = () => {
        if (this.runStarted) {
            return;
        }
        this.runStarted = true;

        // When a test run starts we need to do several things:
        // - Create new TestItems for each paramterized test that was added
        //   and attach them to their parent TestItem.
        // - Create a new test run from the TestRunArguments + newly created TestItems.
        // - Mark all of these test items as enqueued on the test run.

        const addedTestItems = this.addedTestItems
            .map(({ testClass, parentIndex }) => {
                const parent = this.args.testItems[parentIndex];
                // clear out the children before we add the new ones.
                parent.children.replace([]);
                return {
                    testClass,
                    parent,
                };
            })
            .map(({ testClass, parent }) => {
                // strip the location off parameterized tests so only the parent TestItem
                // has one. The parent collects all the issues so they're colated on the top
                // level test item and users can cycle through them with the up/down arrows in the UI.
                testClass.location = undefined;

                const added = upsertTestItem(this.controller, testClass, parent);

                // If we just update leaf nodes the root test controller never realizes that
                // items have updated. This may be a bug in VSCode. We can work around it by
                // re-adding the existing items back up the chain to refresh all the nodes along the way.
                let p = parent;
                while (p?.parent) {
                    p.parent.children.add(p);
                    p = p.parent;
                }

                return added;
            });

        this.testRun = this.controller.createTestRun(this.testRunRequest);
        this._testItems = [...this.testItems, ...addedTestItems];

        // Forward any output captured before the testRun was created.
        for (const outputLine of this.queuedOutput) {
            this.testRun.appendOutput(outputLine);
        }
        this.queuedOutput = [];

        for (const test of this.testItems) {
            this.testRun.enqueued(test);
        }
    };

    public addParameterizedTestCase = (testClass: TestClass, parentIndex: number) => {
        this.addedTestItems.push({ testClass, parentIndex });
    };

    public getTestIndex(id: string, filename?: string): number {
        return this.testItemFinder.getIndex(id, filename);
    }

    private get testItemFinder(): TestItemFinder {
        if (process.platform === "darwin") {
            return new DarwinTestItemFinder(this.testItems);
        } else {
            return new NonDarwinTestItemFinder(this.testItems, this.folderContext);
        }
    }

    public started(test: vscode.TestItem) {
        this.testRun?.started(test);
    }

    public skipped(test: vscode.TestItem) {
        this.runState.skipped.push(test);
        this.testRun?.skipped(test);
    }

    public passed(test: vscode.TestItem, duration?: number) {
        this.runState.passed.push(test);
        this.testRun?.passed(test, duration);
    }

    public failed(
        test: vscode.TestItem,
        message: vscode.TestMessage | readonly vscode.TestMessage[],
        duration?: number
    ) {
        this.runState.failed.push(test);
        this.testRun?.failed(test, message, duration);
    }

    public errored(
        test: vscode.TestItem,
        message: vscode.TestMessage | readonly vscode.TestMessage[],
        duration?: number
    ) {
        this.runState.errored.push(test);
        this.testRun?.errored(test, message, duration);
    }

    public async end() {
        if (!this.testRun) {
            return;
        }

        // Compute final coverage numbers if any coverage info has been captured during the run.
        await this.coverage.computeCoverage(this.testRun);

        this.testRun.end();
    }

    public appendOutput(output: string) {
        if (this.testRun) {
            this.testRun.appendOutput(output);
        } else {
            this.queuedOutput.push(output);
        }
    }
}

/** Class used to run tests */
export class TestRunner {
    private testRun: TestRunProxy;
    private testArgs: TestRunArguments;
    private xcTestOutputParser: XCTestOutputParser;
    private swiftTestOutputParser: SwiftTestingOutputParser;

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
        this.testArgs = new TestRunArguments(this.ensureRequestIncludesTests(this.request));
        this.testRun = new TestRunProxy(request, controller, this.testArgs, folderContext);
        this.xcTestOutputParser = new XCTestOutputParser();
        this.swiftTestOutputParser = new SwiftTestingOutputParser(
            this.testRun.testRunStarted,
            this.testRun.addParameterizedTestCase
        );
    }

    /**
     * If the request has no test items to include in the run,
     * default to usig all the items in the `TestController`.
     */
    private ensureRequestIncludesTests(request: vscode.TestRunRequest): vscode.TestRunRequest {
        if ((request.include?.length ?? 0) > 0) {
            return request;
        }
        const items: vscode.TestItem[] = [];
        this.controller.items.forEach(item => items.push(item));
        return new vscode.TestRunRequest(items, request.exclude, request.profile);
    }

    get workspaceContext(): WorkspaceContext {
        return this.folderContext.workspaceContext;
    }

    /**
     * Setup debug and run test profiles
     * @param controller Test controller
     * @param folderContext Folder tests are running in
     */
    static setupProfiles(
        controller: vscode.TestController,
        folderContext: FolderContext,
        onCreateTestRun: vscode.EventEmitter<TestRunProxy>
    ): vscode.TestRunProfile[] {
        return [
            // Add non-debug profile
            controller.createRunProfile(
                RunProfileName.run,
                vscode.TestRunProfileKind.Run,
                async (request, token) => {
                    const runner = new TestRunner(request, folderContext, controller);
                    onCreateTestRun.fire(runner.testRun);
                    await runner.runHandler(false, TestKind.standard, token);
                },
                true,
                runnableTag
            ),
            // Add non-debug profile
            controller.createRunProfile(
                RunProfileName.runParallel,
                vscode.TestRunProfileKind.Run,
                async (request, token) => {
                    const runner = new TestRunner(request, folderContext, controller);
                    onCreateTestRun.fire(runner.testRun);
                    await runner.runHandler(false, TestKind.parallel, token);
                },
                false,
                runnableTag
            ),
            // Add coverage profile
            controller.createRunProfile(
                RunProfileName.coverage,
                vscode.TestRunProfileKind.Run,
                async (request, token) => {
                    const runner = new TestRunner(request, folderContext, controller);
                    onCreateTestRun.fire(runner.testRun);
                    await runner.runHandler(false, TestKind.coverage, token);
                },
                false,
                runnableTag
            ),
            // Add debug profile
            controller.createRunProfile(
                RunProfileName.debug,
                vscode.TestRunProfileKind.Debug,
                async (request, token) => {
                    const runner = new TestRunner(request, folderContext, controller);
                    onCreateTestRun.fire(runner.testRun);
                    if (request.profile) {
                        request.profile.loadDetailedCoverage = async (testRun, fileCoverage) => {
                            return runner.testRun.coverage.loadDetailedCoverage(fileCoverage.uri);
                        };
                    }
                    await runner.runHandler(true, TestKind.standard, token);
                    await vscode.commands.executeCommand("testing.openCoverage");
                },
                false,
                runnableTag
            ),
        ];
    }

    /**
     * Test run handler. Run a series of tests and extracts the results from the output
     * @param shouldDebug Should we run the debugger
     * @param token Cancellation token
     * @returns When complete
     */
    async runHandler(shouldDebug: boolean, testKind: TestKind, token: vscode.CancellationToken) {
        const runState = new TestRunnerTestRunState(this.testRun);
        try {
            // run associated build task
            // don't do this if generating code test coverage data as the
            // `swift test --enable-code-coverage` command will rebuild everything again.
            if (testKind !== TestKind.coverage) {
                const task = await getBuildAllTask(this.folderContext);
                task.definition.dontTriggerTestDiscovery =
                    this.folderContext.workspaceContext.swiftVersion.isGreaterThanOrEqual(
                        new Version(6, 0, 0)
                    );

                const exitCode = await this.folderContext.taskQueue.queueOperation(
                    new TaskOperation(task),
                    token
                );

                // if build failed then exit
                if (exitCode === undefined || exitCode !== 0) {
                    await this.testRun.end();
                    return;
                }
            }

            if (shouldDebug) {
                await this.debugSession(token, runState);
            } else {
                await this.runSession(token, testKind, runState);
            }
        } catch (error) {
            this.workspaceContext.outputChannel.log(`Error: ${getErrorDescription(error)}`);
            this.testRun.appendOutput(`\r\nError: ${getErrorDescription(error)}`);
        }

        await this.testRun.end();
    }

    /** Run test session without attaching to a debugger */
    async runSession(
        token: vscode.CancellationToken,
        testKind: TestKind,
        runState: TestRunnerTestRunState
    ) {
        // Run swift-testing first, then XCTest.
        // swift-testing being parallel by default should help these run faster.
        if (this.testArgs.hasSwiftTestingTests) {
            const fifoPipePath =
                process.platform === "win32"
                    ? `\\\\.\\pipe\\vscodemkfifo-${Date.now()}`
                    : path.join(os.tmpdir(), `vscodemkfifo-${Date.now()}`);

            await TemporaryFolder.withNamedTemporaryFile(fifoPipePath, async () => {
                // macOS/Linux require us to create the named pipe before we use it.
                // Windows just lets us communicate by specifying a pipe path without any ceremony.
                if (process.platform !== "win32") {
                    await execFile("mkfifo", [fifoPipePath], undefined, this.folderContext);
                }

                const testBuildConfig =
                    await LaunchConfigurations.createLaunchConfigurationForSwiftTesting(
                        this.testArgs.swiftTestArgs,
                        this.folderContext,
                        fifoPipePath,
                        testKind === TestKind.coverage
                    );

                if (testBuildConfig === null) {
                    return;
                }

                // Output test from stream
                const outputStream = new stream.Writable({
                    write: (chunk, encoding, next) => {
                        const text = chunk.toString();
                        this.testRun.appendOutput(text.replace(/\n/g, "\r\n"));
                        next();
                    },
                });

                if (token.isCancellationRequested) {
                    outputStream.end();
                    return;
                }

                // Watch the pipe for JSONL output and parse the events into test explorer updates.
                // The await simply waits for the watching to be configured.
                await this.swiftTestOutputParser.watch(fifoPipePath, runState);

                await this.launchTests(
                    testKind === TestKind.parallel ? TestKind.standard : testKind,
                    token,
                    outputStream,
                    testBuildConfig
                );
            });
        }

        if (this.testArgs.hasXCTests) {
            const testBuildConfig = LaunchConfigurations.createLaunchConfigurationForXCTestTesting(
                this.testArgs.xcTestArgs,
                this.workspaceContext,
                this.folderContext,
                false,
                testKind === TestKind.coverage
            );
            if (testBuildConfig === null) {
                return;
            }
            // Parse output from stream and output to log
            const parsedOutputStream = new stream.Writable({
                write: (chunk, encoding, next) => {
                    const text = chunk.toString();
                    this.testRun.appendOutput(text.replace(/\n/g, "\r\n"));
                    this.xcTestOutputParser.parseResult(text, runState);
                    next();
                },
            });

            if (token.isCancellationRequested) {
                parsedOutputStream.end();
                return;
            }

            // XCTestRuns are started immediately
            this.testRun.testRunStarted();

            await this.launchTests(testKind, token, parsedOutputStream, testBuildConfig);
        }
    }

    private async launchTests(
        testKind: TestKind,
        token: vscode.CancellationToken,
        outputStream: stream.Writable,
        testBuildConfig: vscode.DebugConfiguration
    ) {
        this.testRun.appendOutput(`> Test run started at ${new Date().toLocaleString()} <\r\n\r\n`);
        try {
            switch (testKind) {
                case TestKind.coverage:
                    await this.runCoverageSession(token, outputStream, testBuildConfig);
                    break;
                case TestKind.parallel:
                    await this.runParallelSession(token, outputStream, testBuildConfig);
                    break;
                default:
                    await this.runStandardSession(token, outputStream, testBuildConfig);
                    break;
            }
        } catch (error) {
            // Test failures result in error code 1
            if (error !== 1) {
                this.testRun.appendOutput(`\r\nError: ${getErrorDescription(error)}`);
            }
        } finally {
            outputStream.end();
        }
    }

    /** Run tests outside of debugger */
    async runStandardSession(
        token: vscode.CancellationToken,
        outputStream: stream.Writable,
        testBuildConfig: vscode.DebugConfiguration
    ) {
        return new Promise<void>((resolve, reject) => {
            const args = testBuildConfig.args ?? [];
            let didError = false;
            let cancellation: vscode.Disposable;

            const exec = new SwiftProcess(testBuildConfig.program, args, {
                cwd: testBuildConfig.cwd,
                env: { ...process.env, ...testBuildConfig.env },
            });

            exec.onDidWrite(str => {
                // Work around SPM still emitting progress when doing --no-build.
                const replaced = str.replace("[1/1] Planning build", "");
                outputStream.write(replaced);
            });

            exec.onDidThrowError(err => {
                didError = true;
                reject(err);
            });

            exec.onDidClose(code => {
                // onDidClose is still called after an error
                if (didError) {
                    return;
                }

                if (cancellation) {
                    cancellation.dispose();
                }

                // undefined or 0 are viewed as success
                if (!code) {
                    resolve();
                } else {
                    reject(code);
                }
            });

            if (token) {
                cancellation = token.onCancellationRequested(() => {
                    exec.kill();
                });
            }

            this.folderContext?.workspaceContext.outputChannel.logDiagnostic(
                `Exec: ${testBuildConfig.program} ${args.join(" ")}`,
                this.folderContext.name
            );
            exec.spawn();
        });
    }

    /** Run tests with code coverage, and parse coverage results */
    async runCoverageSession(
        token: vscode.CancellationToken,
        outputStream: stream.Writable,
        testBuildConfig: vscode.DebugConfiguration
    ) {
        try {
            await this.runStandardSession(token, outputStream, testBuildConfig);
        } catch (error) {
            // If this isn't a standard test failure, forward the error and skip generating coverage.
            if (error !== 1) {
                throw error;
            }
        }

        await this.testRun.coverage.captureCoverage();
    }

    /** Run tests in parallel outside of debugger */
    async runParallelSession(
        token: vscode.CancellationToken,
        outputStream: stream.Writable,
        testBuildConfig: vscode.DebugConfiguration
    ) {
        await this.workspaceContext.tempFolder.withTemporaryFile("xml", async filename => {
            const sanitizer = this.workspaceContext.toolchain.sanitizer(configuration.sanitizer);
            const sanitizerArgs = sanitizer?.buildFlags ?? [];
            const filterArgs = this.testArgs.xcTestArgs.flatMap(arg => ["--filter", arg]);
            const args = [
                "test",
                "--parallel",
                ...sanitizerArgs,
                "--skip-build",
                "--xunit-output",
                filename,
            ];

            // XCTestRuns are started immediately
            this.testRun.testRunStarted();

            try {
                testBuildConfig.args = await this.runStandardSession(token, outputStream, {
                    ...testBuildConfig,
                    args: [...args, filterArgs],
                });
            } catch (error) {
                // If this isn't a standard test failure, forward the error and skip generating coverage.
                if (error !== 1) {
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
        const buildConfigs: Array<vscode.DebugConfiguration | undefined> = [];

        const fifoPipePath =
            process.platform === "win32"
                ? `\\\\.\\pipe\\vscodemkfifo-${Date.now()}`
                : path.join(os.tmpdir(), `vscodemkfifo-${Date.now()}`);

        await TemporaryFolder.withNamedTemporaryFile(fifoPipePath, async () => {
            // macOS/Linux require us to create the named pipe before we use it.
            // Windows just lets us communicate by specifying a pipe path without any ceremony.
            if (process.platform !== "win32") {
                await execFile("mkfifo", [fifoPipePath], undefined, this.folderContext);
            }

            if (this.testArgs.hasSwiftTestingTests) {
                const swiftTestBuildConfig =
                    await LaunchConfigurations.createLaunchConfigurationForSwiftTesting(
                        this.testArgs.swiftTestArgs,
                        this.folderContext,
                        fifoPipePath,
                        false
                    );

                if (swiftTestBuildConfig !== null) {
                    // given we have already run a build task there is no need to have a pre launch task
                    // to build the tests
                    swiftTestBuildConfig.preLaunchTask = undefined;

                    // output test build configuration
                    if (configuration.diagnostics) {
                        const configJSON = JSON.stringify(swiftTestBuildConfig);
                        this.workspaceContext.outputChannel.logDiagnostic(
                            `swift-testing Debug Config: ${configJSON}`,
                            this.folderContext.name
                        );

                        if (swiftTestBuildConfig !== null) {
                            // given we have already run a build task there is no need to have a pre launch task
                            // to build the tests
                            swiftTestBuildConfig.preLaunchTask = undefined;

                            // output test build configuration
                            if (configuration.diagnostics) {
                                const configJSON = JSON.stringify(swiftTestBuildConfig);
                                this.workspaceContext.outputChannel.logDiagnostic(
                                    `swift-testing Debug Config: ${configJSON}`,
                                    this.folderContext.name
                                );
                            }
                            // Watch the pipe for JSONL output and parse the events into test explorer updates.
                            // The await simply waits for the watching to be configured.
                            await this.swiftTestOutputParser.watch(fifoPipePath, runState);

                            buildConfigs.push(swiftTestBuildConfig);
                        }
                    }
                }

                // create launch config for testing
                if (this.testArgs.hasXCTests) {
                    const xcTestBuildConfig =
                        await LaunchConfigurations.createLaunchConfigurationForXCTestTesting(
                            this.testArgs.xcTestArgs,
                            this.workspaceContext,
                            this.folderContext,
                            true,
                            false
                        );

                    if (xcTestBuildConfig !== null) {
                        // given we have already run a build task there is no need to have a pre launch task
                        // to build the tests
                        xcTestBuildConfig.preLaunchTask = undefined;

                        // output test build configuration
                        if (configuration.diagnostics) {
                            const configJSON = JSON.stringify(xcTestBuildConfig);
                            this.workspaceContext.outputChannel.logDiagnostic(
                                `XCTest Debug Config: ${configJSON}`,
                                this.folderContext.name
                            );
                        }

                        buildConfigs.push(xcTestBuildConfig);
                    }
                }

                const validBuildConfigs = buildConfigs.filter(
                    config => config !== null
                ) as vscode.DebugConfiguration[];

                const subscriptions: vscode.Disposable[] = [];

                const debugRuns = validBuildConfigs.map(config => {
                    return () =>
                        new Promise<void>((resolve, reject) => {
                            // add cancelation
                            const startSession = vscode.debug.onDidStartDebugSession(session => {
                                this.workspaceContext.outputChannel.logDiagnostic(
                                    "Start Test Debugging",
                                    this.folderContext.name
                                );
                                LoggingDebugAdapterTracker.setDebugSessionCallback(
                                    session,
                                    output => {
                                        this.testRun.appendOutput(output);
                                        this.xcTestOutputParser.parseResult(output, runState);
                                    }
                                );
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

                            vscode.debug
                                .startDebugging(this.folderContext.workspaceFolder, config)
                                .then(
                                    started => {
                                        if (started) {
                                            if (config === validBuildConfigs[0]) {
                                                this.testRun.appendOutput(
                                                    `> Test run started at ${new Date().toLocaleString()} <\r\n\r\n`
                                                );
                                            }
                                            // show test results pane
                                            vscode.commands.executeCommand(
                                                "testing.showMostRecentOutput"
                                            );

                                            const terminateSession =
                                                vscode.debug.onDidTerminateDebugSession(
                                                    async () => {
                                                        this.workspaceContext.outputChannel.logDiagnostic(
                                                            "Stop Test Debugging",
                                                            this.folderContext.name
                                                        );
                                                        // dispose terminate debug handler
                                                        subscriptions.forEach(sub => sub.dispose());

                                                        vscode.commands.executeCommand(
                                                            "workbench.view.extension.test"
                                                        );

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
                });

                // Run each debugging session sequentially
                await debugRuns.reduce((p, fn) => p.then(() => fn()), Promise.resolve());
            }
        });
    }

    /** Get TestItem finder for current platform */
    get testItemFinder(): TestItemFinder {
        if (process.platform === "darwin") {
            return new DarwinTestItemFinder(this.testArgs.testItems);
        } else {
            return new NonDarwinTestItemFinder(this.testArgs.testItems, this.folderContext);
        }
    }
}

class LaunchConfigurations {
    /**
     * Edit launch configuration to run tests
     * @param debugging Do we need this configuration for debugging
     * @param outputFile Debug output file
     * @returns
     */
    static createLaunchConfigurationForXCTestTesting(
        args: string[],
        workspaceContext: WorkspaceContext,
        folderContext: FolderContext,
        debugging: boolean,
        coverage: boolean
    ): vscode.DebugConfiguration | null {
        const testList = args.join(",");

        if (process.platform === "darwin") {
            // if debugging on macOS with Swift 5.6 we need to create a custom launch
            // configuration so we can set the system architecture
            const swiftVersion = workspaceContext.toolchain.swiftVersion;
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
                const testBuildConfig = createDarwinTestConfiguration(folderContext, testFilterArg);
                if (testBuildConfig === null) {
                    return null;
                }
                return testBuildConfig;
            } else {
                const testBuildConfig = createXCTestConfiguration(folderContext, true);
                if (testBuildConfig === null) {
                    return null;
                }

                let additionalArgs: string[] = [];
                if (testList.length > 0) {
                    additionalArgs = args.flatMap(arg => ["--filter", regexEscapedString(arg)]);
                }

                if (coverage) {
                    additionalArgs = [...additionalArgs, "--enable-code-coverage"];
                }

                testBuildConfig.args = [...testBuildConfig.args, ...additionalArgs];
                testBuildConfig.terminal = "console";

                return testBuildConfig;
            }
        } else {
            const testBuildConfig = createXCTestConfiguration(folderContext, true);
            if (testBuildConfig === null) {
                return null;
            }

            let testFilterArg: string[] = [];
            if (testList.length > 0) {
                testFilterArg = args.flatMap(arg => ["--filter", regexEscapedString(arg)]);
            }
            if (coverage) {
                testFilterArg = [...testFilterArg, "--enable-code-coverage"];
            }
            testBuildConfig.args = [...testBuildConfig.args, ...testFilterArg];

            // output test logging to debug console so we can catch it with a tracker
            testBuildConfig.terminal = "console";
            return testBuildConfig;
        }
    }

    static async createLaunchConfigurationForSwiftTesting(
        args: string[],
        folderContext: FolderContext,
        fifoPipePath: string,
        coverage: boolean
    ): Promise<vscode.DebugConfiguration | null> {
        const testList = args.join(",");

        const testBuildConfig = createSwiftTestConfiguration(folderContext, fifoPipePath, true);
        if (testBuildConfig === null) {
            return null;
        }

        let additionalArgs: string[] = [];
        if (testList.length > 0) {
            additionalArgs = args.flatMap(arg => ["--filter", regexEscapedString(arg)]);
        }

        if (coverage) {
            additionalArgs = [...additionalArgs, "--enable-code-coverage"];
        }

        testBuildConfig.args = [...testBuildConfig.args, ...additionalArgs];
        testBuildConfig.terminal = "console";
        return testBuildConfig;
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
class TestRunnerTestRunState implements ITestRunState {
    constructor(private testRun: TestRunProxy) {}

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
    private startTimes: Map<number, number | undefined> = new Map();
    private issues: Map<number, vscode.TestMessage[]> = new Map();

    getTestItemIndex(id: string, filename?: string): number {
        return this.testRun.getTestIndex(id, filename);
    }

    // set test item to be started
    started(index: number, startTime?: number) {
        const testItem = this.testRun.testItems[index];
        this.testRun.started(testItem);
        this.currentTestItem = testItem;
        this.startTimes.set(index, startTime);
    }

    // set test item to have passed
    completed(index: number, timing: { duration: number } | { timestamp: number }) {
        const test = this.testRun.testItems[index];
        const startTime = this.startTimes.get(index);

        let duration: number;
        if ("timestamp" in timing) {
            // Completion was specified in timestamp format but the test has no saved `started` timestamp.
            // This is a bug in the code and can't be caused by a user.
            if (startTime === undefined) {
                throw Error(
                    "Timestamp was provided on test completion, but there was no startTime set when the test was started."
                );
            }
            duration = (timing.timestamp - startTime) * 1000;
        } else {
            duration = timing.duration * 1000;
        }

        const issues = this.issues.get(index) ?? [];
        if (issues.length > 0) {
            this.testRun.failed(test, issues, duration);
        } else {
            this.testRun.passed(test, duration);
        }

        this.lastTestItem = this.currentTestItem;
        this.currentTestItem = undefined;
    }

    recordIssue(
        index: number,
        message: string | vscode.MarkdownString,
        location?: vscode.Location
    ) {
        const msg = new vscode.TestMessage(message);
        msg.location = location;
        const issueList = this.issues.get(index) ?? [];
        issueList.push(msg);
        this.issues.set(index, issueList);
    }

    // set test item to have been skipped
    skipped(index: number) {
        this.testRun.skipped(this.testRun.testItems[index]);
        this.lastTestItem = this.currentTestItem;
        this.currentTestItem = undefined;
    }

    // started suite
    startedSuite() {
        // Nothing to do here
    }
    // passed suite
    passedSuite() {
        // Nothing to do here
    }
    // failed suite
    failedSuite() {
        // Nothing to do here
    }
}

class TestRunnerXUnitTestState implements iXUnitTestState {
    constructor(
        private testItemFinder: TestItemFinder,
        private testRun: TestRunProxy
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
