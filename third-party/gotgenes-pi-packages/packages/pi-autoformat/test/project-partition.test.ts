/**
 * Guards the `unit` / `acceptance` Vitest project split.
 *
 * The split only keeps real-CLI spawns off the default `pnpm test` path while
 * `ACCEPTANCE_FILES` names every test file that spawns one. This derives the
 * real set from the sources instead of trusting a second hand-maintained list,
 * so adding a real-CLI test without listing it fails here rather than
 * resurfacing later as a load flake (#678).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { ACCEPTANCE_FILES } from "./acceptance-files";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const TEST_DIR = join(PACKAGE_ROOT, "test");

/**
 * The harness call that marks a test file as driving the real `pi` CLI.
 *
 * Matched as a call rather than an import because import formatting varies
 * (a long specifier list gets wrapped) while an unaliased call site does not.
 *
 * The residual gap is an aliased import: `runRpcSession as run` would be
 * called as `run(...)` and escape this predicate, landing a real-CLI file in
 * the `unit` project with this guard still green. Nothing aliases it today.
 * If that changes, match the import instead of the call.
 */
const HARNESS_CALL = "runRpcSession(";

/** This guard names the marker string above, so it must exempt itself. */
const GUARD_FILE = "test/project-partition.test.ts";

/** Every `*.test.ts` under `test/`, as package-root-relative posix paths. */
function testFilePaths(): string[] {
  return readdirSync(TEST_DIR, { recursive: true, encoding: "utf-8" })
    .filter((entry) => entry.endsWith(".test.ts"))
    .map((entry) => `test/${entry.split(sep).join("/")}`);
}

/** The subset of test files that call the real-`pi` RPC harness. */
function realCliTestPaths(): string[] {
  return testFilePaths()
    .filter((path) => path !== GUARD_FILE)
    .filter((path) =>
      readFileSync(join(PACKAGE_ROOT, path), "utf-8").includes(HARNESS_CALL),
    );
}

describe("vitest project partition", () => {
  it("segregates exactly the test files that spawn the real pi CLI", () => {
    expect(realCliTestPaths().toSorted()).toEqual(
      [...ACCEPTANCE_FILES].toSorted(),
    );
  });

  it("names only files that exist on disk", () => {
    const discovered = testFilePaths();
    const missing = ACCEPTANCE_FILES.filter(
      (path) => !discovered.includes(path),
    );

    expect(missing).toEqual([]);
  });
});
