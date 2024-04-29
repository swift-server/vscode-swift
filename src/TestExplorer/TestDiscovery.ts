//===----------------------------------------------------------------------===//
//
// This source file is part of the VSCode Swift open source project
//
// Copyright (c) 2024 the VSCode Swift project authors
// Licensed under Apache License v2.0
//
// See LICENSE.txt for license information
// See CONTRIBUTORS.txt for the list of VSCode Swift project authors
//
// SPDX-License-Identifier: Apache-2.0
//
//===----------------------------------------------------------------------===//

import * as vscode from "vscode";
import { FolderContext } from "../FolderContext";
import { TargetType } from "../SwiftPackage";

/** Test function definition */
export interface TestFunction {
    name: string;
    location?: vscode.Location;
}

/** Test class definition */
export interface TestClass {
    name: string;
    location?: vscode.Location;
    extension?: boolean;
    functions: TestFunction[];
}

/** Test target definition */
export interface TestTarget {
    name: string;
    folder?: vscode.Uri;
    classes: TestClass[];
}

/**
 * Update Test Controller TestItems based off array of TestClasses.
 *
 * The function creates the TestTargets based off the test targets in the Swift
 * Package
 * @param folderContext Folder test classes came
 * @param testClasses Array of test classes
 */
export function updateTestsFromClasses(folderContext: FolderContext, testClasses: TestClass[]) {
    const testExplorer = folderContext.testExplorer;
    if (!testExplorer) {
        return;
    }
    const targets = folderContext.swiftPackage.getTargets(TargetType.test).map(target => {
        const classes = testClasses.filter(
            testClass =>
                testClass.location &&
                folderContext.swiftPackage.getTarget(testClass.location.uri.fsPath) === target
        );
        return {
            name: target.name,
            folder: vscode.Uri.file(target.path),
            classes: classes,
        };
    });
    updateTests(testExplorer.controller, targets);
}

/**
 * Update Test Controller TestItems based off array of TestTargets
 * @param testController Test controller
 * @param testTargets Array of TestTargets
 * @param filterFile Filter test deletion just for tests in the one file
 */
export function updateTests(
    testController: vscode.TestController,
    testTargets: TestTarget[],
    filterFile?: vscode.Uri
) {
    // remove TestItems that aren't in testTarget list
    testController.items.forEach(targetItem => {
        const testTarget = testTargets.find(item => item.name === targetItem.id);
        if (testTarget) {
            const targetId = targetItem.id;
            targetItem.children.forEach(classItem => {
                const testClass = testTarget.classes.find(
                    item => `${targetId}.${item.name}` === classItem.id
                );
                if (testClass) {
                    const classId = classItem.id;
                    classItem.children.forEach(functionItem => {
                        // if we are filtering based on targets being one file and this
                        // function isn't in the file then ignore
                        if (filterFile && functionItem.uri?.fsPath !== filterFile.fsPath) {
                            return;
                        }
                        const testFunction = testClass.functions.find(
                            item => `${classId}/${item.name}` === functionItem.id
                        );
                        if (!testFunction) {
                            classItem.children.delete(functionItem.id);
                        }
                    });
                    if (classItem.children.size === 0) {
                        targetItem.children.delete(classItem.id);
                    }
                } else {
                    if (!filterFile) {
                        targetItem.children.delete(classItem.id);
                    } else if (classItem.uri?.fsPath === filterFile.fsPath) {
                        // If filtering on a file and a class is in that file and all its
                        // functions are in that file then delete the class
                        let allInFilteredFile = true;
                        classItem.children.forEach(func => {
                            if (func.uri?.fsPath !== filterFile.fsPath) {
                                allInFilteredFile = false;
                            }
                        });
                        if (allInFilteredFile) {
                            targetItem.children.delete(classItem.id);
                        }
                    }
                }
            });
            if (targetItem.children.size === 0) {
                testController.items.delete(targetItem.id);
            }
        } else if (!filterFile) {
            testController.items.delete(targetItem.id);
        }
    });

    // Add in new items, update items already in place
    testTargets.forEach(testTarget => {
        const targetItem =
            testController.items.get(testTarget.name) ??
            createTopLevelTestItem(testController, testTarget.name, testTarget.folder);
        testTarget.classes.forEach(testClass => {
            const classItem = updateChildTestItem(
                testController,
                targetItem,
                testClass.name,
                ".",
                testClass.extension !== true,
                testClass.location
            );
            if (classItem) {
                testClass.functions.forEach(testFunction => {
                    updateChildTestItem(
                        testController,
                        classItem,
                        testFunction.name,
                        "/",
                        true,
                        testFunction.location
                    );
                });
            }
        });
    });
}

/** Create top level test item and add it to the test controller */
function createTopLevelTestItem(
    testController: vscode.TestController,
    name: string,
    uri?: vscode.Uri
): vscode.TestItem {
    const testItem = testController.createTestItem(name, name, uri);
    testController.items.add(testItem);
    return testItem;
}

/** Update a child test item or if it doesn't exist create a new test item  */
function updateChildTestItem(
    testController: vscode.TestController,
    parent: vscode.TestItem,
    name: string,
    separator: string,
    addNewItem: boolean,
    location?: vscode.Location
): vscode.TestItem | undefined {
    const id = `${parent.id}${separator}${name}`;
    const testItem = parent.children.get(id);
    if (testItem) {
        if (testItem.uri?.fsPath === location?.uri.fsPath || location === undefined) {
            testItem.range = location?.range;
            return testItem;
        }
        parent.children.delete(testItem.id);
    } else if (addNewItem === false) {
        return undefined;
    }
    const newTestItem = testController.createTestItem(id, name, location?.uri);
    newTestItem.range = location?.range;
    parent.children.add(newTestItem);
    return newTestItem;
}
