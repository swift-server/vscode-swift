//===----------------------------------------------------------------------===//
//
// This source file is part of the VSCode Swift open source project
//
// Copyright (c) 2023 the VSCode Swift project authors
// Licensed under Apache License v2.0
//
// See LICENSE.txt for license information
// See CONTRIBUTORS.txt for the list of VSCode Swift project authors
//
// SPDX-License-Identifier: Apache-2.0
//
//===----------------------------------------------------------------------===//

import * as path from "path";
import { SwiftToolchain } from "./toolchain";

export class Sanitizer {
    private constructor(
        public type: "thread" | "address",
        public toolchain: SwiftToolchain
    ) {}

    /** create sanitizer */
    static create(type: string, toolchain: SwiftToolchain): Sanitizer | undefined {
        if (type === "thread" || type === "address") {
            return new Sanitizer(type, toolchain);
        }
    }

    /** Return runtime environment variables for macOS */
    get runtimeEnvironment(): Record<string, string> | undefined {
        if (!this.toolchain.toolchainPath) {
            return undefined;
        }
        const lib = `/lib/swift/clang/lib/darwin/libclang_rt.${this.clangName}_osx_dynamic.dylib`;
        const libFullPath = path.join(this.toolchain.toolchainPath, lib);
        return { DYLD_INSERT_LIBRARIES: libFullPath };
    }

    /** return build flags */
    get buildFlags(): [string] {
        return [`--sanitize=${this.type}`];
    }

    get clangName(): string {
        switch (this.type) {
            case "address":
                return "asan";
            case "thread":
                return "tsan";
        }
    }
}
