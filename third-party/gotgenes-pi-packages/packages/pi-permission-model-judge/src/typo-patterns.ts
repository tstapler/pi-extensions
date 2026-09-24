/**
 * The cost gate: compile the operator's `typoPatterns` to regexes and test a
 * candidate path against them.
 *
 * Only a path that matches a configured pattern reaches the model — an empty or
 * absent pattern list matches nothing, so the reviewer defers everything
 * without a model call.
 */

/**
 * Result of compiling a pattern list: usable regexes (with their original
 * source strings, parallel to `regexes`) plus any that failed to compile.
 * `patterns[i]` is the operator's literal config string for `regexes[i]`, kept
 * so the decision trail records the pattern as written, not the slash-escaped
 * `RegExp.source`.
 */
export interface CompiledTypoPatterns {
  regexes: RegExp[];
  patterns: string[];
  invalidPatterns: string[];
}

/**
 * Compile each pattern string to a `RegExp`, skipping any that `RegExp` rejects
 * (recorded in `invalidPatterns` so the caller can warn). Patterns compile
 * without flags, so `test` is stateless across calls.
 */
export function compileTypoPatterns(
  patterns: readonly string[],
): CompiledTypoPatterns {
  const regexes: RegExp[] = [];
  const sources: string[] = [];
  const invalidPatterns: string[] = [];
  for (const pattern of patterns) {
    try {
      regexes.push(new RegExp(pattern));
      sources.push(pattern);
    } catch {
      invalidPatterns.push(pattern);
    }
  }
  return { regexes, patterns: sources, invalidPatterns };
}

/**
 * The source string of the first compiled pattern that matches `path`, or
 * `undefined` if none do. The source (not the boolean) so the decision trail
 * can record *which* pattern matched.
 */
export function matchTypoPattern(
  path: string,
  compiled: CompiledTypoPatterns,
): string | undefined {
  const index = compiled.regexes.findIndex((regex) => regex.test(path));
  return index === -1 ? undefined : compiled.patterns[index];
}
