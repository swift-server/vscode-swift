//===----------------------------------------------------------------------===//
//
// This source file is part of the VSCode Swift open source project
//
// Copyright (c) 2022 the VSCode Swift project authors
// Licensed under Apache License v2.0
//
// See LICENSE.txt for license information
// See CONTRIBUTORS.txt for the list of VSCode Swift project authors
//
// SPDX-License-Identifier: Apache-2.0
//
//===----------------------------------------------------------------------===//

/**
 * Wrapper class for a Result that might contain either success or failure
 */
export class Result<Success> {
    private constructor(
        readonly success?: Success,
        readonly failure?: unknown
    ) {}

    /** Return a successful result */
    static makeSuccess<Success>(success: Success): Result<Success> {
        return new Result(success);
    }

    /** Return a failed result */
    static makeFailure<Success>(failure: unknown): Result<Success> {
        return new Result<Success>(undefined, failure);
    }
}
