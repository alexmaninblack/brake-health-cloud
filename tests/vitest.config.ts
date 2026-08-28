// SPDX-FileCopyrightText: 2026 maninblack
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    include: [
      "apps/**/test/**/*.test.ts",
      "apps/**/test/**/*.test.tsx",
      "packages/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
  },
});
