import * as vscode from "vscode";
import * as assert from "assert";
import { beforeEach } from "mocha";
import { testAssetUri } from "../../fixtures";
import { globalWorkspaceContextPromise } from "../extension.test";
import { TestExplorer } from "../../../src/TestExplorer/TestExplorer";
import {
    assertTestControllerHierarchy,
    assertTestResults,
    eventPromise,
    getTestItem,
    syncPromise,
} from "./utilities";
import { WorkspaceContext } from "../../../src/WorkspaceContext";
import { RunProfileName, TestRunProxy } from "../../../src/TestExplorer/TestRunner";
import { Version } from "../../../src/utilities/version";

suite("Test Explorer Suite", function () {
    const MAX_TEST_RUN_TIME_MINUTES = 5;

    this.timeout(1000 * 60 * MAX_TEST_RUN_TIME_MINUTES);

    let workspaceContext: WorkspaceContext;
    let testExplorer: TestExplorer;

    async function waitForTestExplorerReady(): Promise<vscode.TestController> {
        return (
            await Promise.all([
                testExplorer.controller.items.size === 0
                    ? eventPromise(testExplorer.onTestItemsDidChange)
                    : Promise.resolve(testExplorer.controller),
                syncPromise(() => vscode.commands.executeCommand("workbench.view.testing.focus")),
            ])
        )[0];
    }

    async function runTest(
        controller: vscode.TestController,
        runProfile: RunProfileName,
        ...tests: string[]
    ): Promise<TestRunProxy> {
        const targetProfile = testExplorer.testRunProfiles.find(
            profile => profile.label === runProfile
        );
        if (!targetProfile) {
            throw new Error(`Unable to find run profile named ${runProfile}`);
        }

        const testItems = tests.map(test => {
            const testItem = getTestItem(controller, test);
            assert.ok(testItem);
            return testItem;
        });

        const request = new vscode.TestRunRequest(testItems);

        return (
            await Promise.all([
                eventPromise(testExplorer.onCreateTestRun),
                targetProfile.runHandler(request, new vscode.CancellationTokenSource().token),
            ])
        )[0];
    }

    suiteSetup(async () => {
        workspaceContext = await globalWorkspaceContextPromise;
    });

    beforeEach(async () => {
        const packageFolder = testAssetUri("defaultPackage");
        const targetFolder = workspaceContext.folders.find(
            folder => folder.folder.path === packageFolder.path
        );
        if (!targetFolder || !targetFolder.testExplorer) {
            throw new Error("Unable to find test explorer");
        }
        testExplorer = targetFolder.testExplorer;

        // Set up the listener before bringing the text explorer in to focus,
        // which starts searching the workspace for tests.
        await waitForTestExplorerReady();
    });

    test("Finds Tests", async function () {
        if (workspaceContext.swiftVersion.isGreaterThanOrEqual(new Version(6, 0, 0))) {
            // 6.0 uses the LSP which returns tests in the order they're declared.
            // Includes swift-testing tests.
            assertTestControllerHierarchy(testExplorer.controller, [
                "PackageTests",
                [
                    "PassingXCTestSuite",
                    ["testPassing()"],
                    "FailingXCTestSuite",
                    ["testFailing()"],
                    "MixedXCTestSuite",
                    ["testPassing()", "testFailing()"],
                    "topLevelTestPassing()",
                    "topLevelTestFailing()",
                    "MixedSwiftTestingSuite",
                    ["testPassing()", "testFailing()", "testDisabled()"],
                ],
            ]);
        } else if (workspaceContext.swiftVersion.isLessThanOrEqual(new Version(5, 10, 0))) {
            // 5.10 uses `swift test list` which returns test alphabetically, without the round brackets.
            // Does not include swift-testing tests.
            assertTestControllerHierarchy(testExplorer.controller, [
                "PackageTests",
                [
                    "FailingXCTestSuite",
                    ["testFailing"],
                    "MixedXCTestSuite",
                    ["testFailing", "testPassing"],
                    "PassingXCTestSuite",
                    ["testPassing"],
                ],
            ]);
        }
    });

    // Do coverage last as it does a full rebuild, causing the stage after it to have to rebuild as well.
    [RunProfileName.run, RunProfileName.runParallel, RunProfileName.coverage].forEach(
        runProfile => {
            let xcTestFailureMessage: string;

            beforeEach(() => {
                // From 5.7 to 5.10 running with the --parallel option dumps the test results out
                // to the console with no newlines, so it isn't possible to distinguish where errors
                // begin and end. Consequently we can't record them, and so we manually mark them
                // as passed or failed with the message from the xunit xml.
                xcTestFailureMessage =
                    runProfile === RunProfileName.runParallel &&
                    !workspaceContext.toolchain.hasMultiLineParallelTestOutput
                        ? "failed"
                        : "failed - oh no";
            });

            suite(runProfile, () => {
                suite("swift-testing", function () {
                    suiteSetup(function () {
                        if (workspaceContext.swiftVersion.isLessThan(new Version(6, 0, 0))) {
                            this.skip();
                        }
                    });

                    test("Runs passing test", async function () {
                        const testRun = await runTest(
                            testExplorer.controller,
                            runProfile,
                            "PackageTests.topLevelTestPassing()"
                        );

                        assertTestResults(testRun, {
                            passed: ["PackageTests.topLevelTestPassing()"],
                        });
                    });

                    test("Runs failing test", async function () {
                        const testRun = await runTest(
                            testExplorer.controller,
                            runProfile,
                            "PackageTests.topLevelTestFailing()"
                        );

                        assertTestResults(testRun, {
                            failed: [
                                {
                                    test: "PackageTests.topLevelTestFailing()",
                                    issues: ["Expectation failed: 1 == 2"],
                                },
                            ],
                        });
                    });

                    test("Runs Suite", async function () {
                        const testRun = await runTest(
                            testExplorer.controller,
                            runProfile,
                            "PackageTests.MixedSwiftTestingSuite"
                        );

                        assertTestResults(testRun, {
                            passed: [
                                "PackageTests.MixedSwiftTestingSuite/testPassing()",
                                "PackageTests.MixedSwiftTestingSuite",
                            ],
                            skipped: ["PackageTests.MixedSwiftTestingSuite/testDisabled()"],
                            failed: [
                                {
                                    test: "PackageTests.MixedSwiftTestingSuite/testFailing()",
                                    issues: ["Expectation failed: 1 == 2"],
                                },
                            ],
                        });
                    });

                    test("Runs All", async function () {
                        const testRun = await runTest(
                            testExplorer.controller,
                            runProfile,
                            "PackageTests.MixedSwiftTestingSuite",
                            "PackageTests.MixedXCTestSuite"
                        );

                        assertTestResults(testRun, {
                            passed: [
                                "PackageTests.MixedSwiftTestingSuite/testPassing()",
                                "PackageTests.MixedSwiftTestingSuite",
                                "PackageTests.MixedXCTestSuite/testPassing",
                            ],
                            skipped: ["PackageTests.MixedSwiftTestingSuite/testDisabled()"],
                            failed: [
                                {
                                    test: "PackageTests.MixedSwiftTestingSuite/testFailing()",
                                    issues: ["Expectation failed: 1 == 2"],
                                },
                                {
                                    test: "PackageTests.MixedXCTestSuite/testFailing",
                                    issues: [xcTestFailureMessage],
                                },
                            ],
                        });
                    });
                });

                suite("XCTests", () => {
                    test("Runs passing test", async function () {
                        const testRun = await runTest(
                            testExplorer.controller,
                            runProfile,
                            "PackageTests.PassingXCTestSuite/testPassing"
                        );

                        assertTestResults(testRun, {
                            passed: ["PackageTests.PassingXCTestSuite/testPassing"],
                        });
                    });

                    test("Runs failing test", async function () {
                        const testRun = await runTest(
                            testExplorer.controller,
                            runProfile,
                            "PackageTests.FailingXCTestSuite/testFailing"
                        );

                        assertTestResults(testRun, {
                            failed: [
                                {
                                    test: "PackageTests.FailingXCTestSuite/testFailing",
                                    issues: [xcTestFailureMessage],
                                },
                            ],
                        });
                    });

                    test("Runs Suite", async function () {
                        const testRun = await runTest(
                            testExplorer.controller,
                            runProfile,
                            "PackageTests.MixedXCTestSuite"
                        );

                        assertTestResults(testRun, {
                            passed: ["PackageTests.MixedXCTestSuite/testPassing"],
                            failed: [
                                {
                                    test: "PackageTests.MixedXCTestSuite/testFailing",
                                    issues: [xcTestFailureMessage],
                                },
                            ],
                        });
                    });
                });
            });
        }
    );
});
