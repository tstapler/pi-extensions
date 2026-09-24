/**
 * The test files that spawn the real `pi` CLI.
 *
 * These are segregated into their own `acceptance` Vitest project (see
 * `vitest.config.ts`) so they stay off the default `pnpm test` path. Under
 * `pnpm -r run test` every package's vitest runs at once, and the resulting
 * module-import storm starves these real-process spawns until they exceed the
 * RPC harness timeout — a false red in a package the session never touched
 * (#678).
 *
 * Paths are package-root-relative because Vitest resolves `include` and
 * `exclude` globs against the project root.
 *
 * The list is explicit rather than a glob: `test/fallback-acceptance.test.ts`
 * is named "acceptance" but spawns nothing, so it belongs in the default run.
 * `test/project-partition.test.ts` pins this list against the files that
 * actually call the harness, so a new real-CLI test cannot silently rejoin
 * the default run.
 */
export const ACCEPTANCE_FILES: readonly string[] = [
  "test/acceptance.test.ts",
  "test/acceptance-event-bus.test.ts",
];
