//===----------------------------------------------------------------------===//
//
// This source file is part of the VSCode Swift open source project
//
// Copyright (c) 2021-2023 the VSCode Swift project authors
// Licensed under Apache License v2.0
//
// See LICENSE.txt for license information
// See CONTRIBUTORS.txt for the list of VSCode Swift project authors
//
// SPDX-License-Identifier: Apache-2.0
//
//===----------------------------------------------------------------------===//

import * as assert from "assert";
import {
    darwinTestRegex,
    iTestRunState,
    nonDarwinTestRegex,
    TestOutputParser,
} from "../../src/TestExplorer/TestOutputParser";

/** TestStatus */
export enum TestStatus {
    enqueued = "enqueued",
    started = "started",
    passed = "passed",
    failed = "failed",
    skipped = "skipped",
}

/** TestItem */
interface TestItem {
    name: string;
    status: TestStatus;
    issues?: { message: string; location?: { file: string; line: number } }[];
    timing?: { duration: number } | { timestamp: number };
}

interface iTestItemFinder {
    getIndex(id: string): number;
    tests: TestItem[];
}
class DarwinTestItemFinder implements iTestItemFinder {
    constructor(public tests: TestItem[]) {}
    getIndex(id: string): number {
        return this.tests.findIndex(item => item.name === id);
    }
}
class NonDarwinTestItemFinder implements iTestItemFinder {
    constructor(public tests: TestItem[]) {}
    getIndex(id: string): number {
        return this.tests.findIndex(item => item.name.endsWith(id));
    }
}
/** Test implementation of iTestRunState */
class TestRunState implements iTestRunState {
    excess?: string;
    failedTest?: {
        testIndex: number;
        message: string;
        file: string;
        lineNumber: number;
        complete: boolean;
    };
    public testItemFinder: iTestItemFinder;
    get tests(): TestItem[] {
        return this.testItemFinder.tests;
    }
    constructor(testNames: string[], darwin: boolean) {
        const tests = testNames.map(name => {
            return { name: name, status: TestStatus.enqueued };
        });
        if (darwin) {
            this.testItemFinder = new DarwinTestItemFinder(tests);
        } else {
            this.testItemFinder = new NonDarwinTestItemFinder(tests);
        }
    }

    getTestItemIndex(id: string): number {
        return this.testItemFinder.getIndex(id);
    }
    started(index: number): void {
        this.testItemFinder.tests[index].status = TestStatus.started;
    }
    completed(index: number, timing: { duration: number } | { timestamp: number }): void {
        this.testItemFinder.tests[index].status =
            this.testItemFinder.tests[index].issues !== undefined
                ? TestStatus.failed
                : TestStatus.passed;
        this.testItemFinder.tests[index].timing = timing;
    }
    recordIssue(index: number, message: string, location?: { file: string; line: number }): void {
        this.testItemFinder.tests[index].issues = [
            ...(this.testItemFinder.tests[index].issues ?? []),
            { message, location },
        ];
        this.testItemFinder.tests[index].status = TestStatus.failed;
    }
    skipped(index: number): void {
        this.testItemFinder.tests[index].status = TestStatus.skipped;
    }

    // started suite
    startedSuite() {
        //
    }
    // passed suite
    passedSuite() {
        //
    }
    // failed suite
    failedSuite() {
        //
    }
}

suite("TestOutputParser Suite", () => {
    const outputParser = new TestOutputParser();

    suite("Darwin", () => {
        test("Passed Test", async () => {
            const testRunState = new TestRunState(["MyTests.MyTests/testPass"], true);
            const runState = testRunState.tests[0];
            outputParser.parseResult(
                `Test Case '-[MyTests.MyTests testPass]' started.
Test Case '-[MyTests.MyTests testPass]' passed (0.001 seconds).
`,
                testRunState,
                darwinTestRegex
            );
            assert.strictEqual(runState.status, TestStatus.passed);
            assert.deepEqual(runState.timing, { duration: 0.001 });
        });

        test("Failed Test", async () => {
            const testRunState = new TestRunState(["MyTests.MyTests/testFail"], true);
            const runState = testRunState.tests[0];
            outputParser.parseResult(
                `Test Case '-[MyTests.MyTests testPublish]' started.
/Users/user/Developer/MyTests/MyTests.swift:59: error: -[MyTests.MyTests testFail] : XCTAssertEqual failed: ("1") is not equal to ("2")
Test Case '-[MyTests.MyTests testFail]' failed (0.106 seconds).
`,
                testRunState,
                darwinTestRegex
            );
            assert.strictEqual(runState.status, TestStatus.failed);
            assert.deepEqual(runState.issues, [
                {
                    message: `XCTAssertEqual failed: ("1") is not equal to ("2")`,
                    location: {
                        file: "/Users/user/Developer/MyTests/MyTests.swift",
                        line: 59,
                    },
                },
            ]);
        });

        test("Skipped Test", async () => {
            const testRunState = new TestRunState(["MyTests.MyTests/testSkip"], true);
            const runState = testRunState.tests[0];
            outputParser.parseResult(
                `Test Case '-[MyTests.MyTests testSkip]' started.
/Users/user/Developer/MyTests/MyTests.swift:90: -[MyTests.MyTests testSkip] : Test skipped
Test Case '-[MyTests.MyTests testSkip]' skipped (0.002 seconds).
`,
                testRunState,
                darwinTestRegex
            );
            assert.strictEqual(runState.status, TestStatus.skipped);
        });

        test("Multi-line Fail", async () => {
            const testRunState = new TestRunState(["MyTests.MyTests/testFail"], true);
            const runState = testRunState.tests[0];
            outputParser.parseResult(
                `Test Case '-[MyTests.MyTests testFail]' started.
/Users/user/Developer/MyTests/MyTests.swift:59: error: -[MyTests.MyTests testFail] : failed - Multiline
fail
message
Test Case '-[MyTests.MyTests testFail]' failed (0.571 seconds).
`,
                testRunState,
                darwinTestRegex
            );
            assert.strictEqual(runState.status, TestStatus.failed);
            assert.deepEqual(runState.issues, [
                {
                    message: `failed - Multiline
fail
message`,
                    location: {
                        file: "/Users/user/Developer/MyTests/MyTests.swift",
                        line: 59,
                    },
                },
            ]);
        });

        test("Multi-line Fail followed by another error", async () => {
            const testRunState = new TestRunState(["MyTests.MyTests/testFail"], true);
            const runState = testRunState.tests[0];
            outputParser.parseResult(
                `Test Case '-[MyTests.MyTests testFail]' started.
/Users/user/Developer/MyTests/MyTests.swift:59: error: -[MyTests.MyTests testFail] : failed - Multiline
fail
message
/Users/user/Developer/MyTests/MyTests.swift:61: error: -[MyTests.MyTests testFail] : failed - Again
Test Case '-[MyTests.MyTests testFail]' failed (0.571 seconds).
`,
                testRunState,
                darwinTestRegex
            );
            assert.strictEqual(runState.status, TestStatus.failed);
            assert.deepEqual(runState.issues, [
                {
                    message: `failed - Multiline
fail
message`,
                    location: {
                        file: "/Users/user/Developer/MyTests/MyTests.swift",
                        line: 59,
                    },
                },
                {
                    message: `failed - Again`,
                    location: {
                        file: "/Users/user/Developer/MyTests/MyTests.swift",
                        line: 61,
                    },
                },
            ]);
        });

        test("Single-line Fail followed by another error", async () => {
            const testRunState = new TestRunState(["MyTests.MyTests/testFail"], true);
            const runState = testRunState.tests[0];
            outputParser.parseResult(
                `Test Case '-[MyTests.MyTests testFail]' started.
/Users/user/Developer/MyTests/MyTests.swift:59: error: -[MyTests.MyTests testFail] : failed - Message
/Users/user/Developer/MyTests/MyTests.swift:61: error: -[MyTests.MyTests testFail] : failed - Again
Test Case '-[MyTests.MyTests testFail]' failed (0.571 seconds).
`,
                testRunState,
                darwinTestRegex
            );
            assert.strictEqual(runState.status, TestStatus.failed);
            assert.deepEqual(runState.issues, [
                {
                    message: `failed - Message`,
                    location: {
                        file: "/Users/user/Developer/MyTests/MyTests.swift",
                        line: 59,
                    },
                },
                {
                    message: `failed - Again`,
                    location: {
                        file: "/Users/user/Developer/MyTests/MyTests.swift",
                        line: 61,
                    },
                },
            ]);
        });

        test("Split line", async () => {
            const testRunState = new TestRunState(["MyTests.MyTests/testPass"], true);
            const runState = testRunState.tests[0];
            outputParser.parseResult(
                `Test Case '-[MyTests.MyTests testPass]' started.
Test Case '-[MyTests.MyTests`,
                testRunState,
                darwinTestRegex
            );
            outputParser.parseResult(
                ` testPass]' passed (0.006 seconds).
`,
                testRunState,
                darwinTestRegex
            );
            assert.strictEqual(runState.status, TestStatus.passed);
            assert.deepEqual(runState.timing, { duration: 0.006 });
        });
    });

    suite("Linux", () => {
        test("Passed Test", async () => {
            const testRunState = new TestRunState(["MyTests.MyTests/testPass"], false);
            const runState = testRunState.tests[0];
            outputParser.parseResult(
                `Test Case 'MyTests.testPass' started.
Test Case 'MyTests.testPass' passed (0.001 seconds).
`,
                testRunState,
                nonDarwinTestRegex
            );
            assert.strictEqual(runState.status, TestStatus.passed);
            assert.deepEqual(runState.timing, { duration: 0.001 });
        });

        test("Failed Test", async () => {
            const testRunState = new TestRunState(["MyTests.MyTests/testFail"], false);
            const runState = testRunState.tests[0];
            outputParser.parseResult(
                `Test Case 'MyTests.testFail' started.
/Users/user/Developer/MyTests/MyTests.swift:59: error: MyTests.testFail : XCTAssertEqual failed: ("1") is not equal to ("2")
Test Case 'MyTests.testFail' failed (0.106 seconds).
`,
                testRunState,
                nonDarwinTestRegex
            );
            assert.strictEqual(runState.status, TestStatus.failed);
            assert.deepEqual(runState.issues, [
                {
                    message: `XCTAssertEqual failed: ("1") is not equal to ("2")`,
                    location: {
                        file: "/Users/user/Developer/MyTests/MyTests.swift",
                        line: 59,
                    },
                },
            ]);
        });

        test("Skipped Test", async () => {
            const testRunState = new TestRunState(["MyTests.MyTests/testSkip"], false);
            const runState = testRunState.tests[0];
            outputParser.parseResult(
                `Test Case 'MyTests.testSkip' started.
/Users/user/Developer/MyTests/MyTests.swift:90: MyTests.testSkip : Test skipped
Test Case 'MyTests.testSkip' skipped (0.002 seconds).
`,
                testRunState,
                nonDarwinTestRegex
            );
            assert.strictEqual(runState.status, TestStatus.skipped);
        });
    });
});
