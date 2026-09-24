import { describe, expect, it } from "vitest";

import { compileTypoPatterns, matchTypoPattern } from "#src/typo-patterns";

describe("compileTypoPatterns", () => {
  it("compiles valid patterns and reports none invalid", () => {
    const compiled = compileTypoPatterns([
      "pi-permission-system/packages/pi-permission-system",
      "\\bnode_modules\\b",
    ]);
    expect(compiled.regexes).toHaveLength(2);
    expect(compiled.invalidPatterns).toEqual([]);
  });

  it("skips an invalid regex and records it", () => {
    const compiled = compileTypoPatterns(["valid", "(unclosed"]);
    expect(compiled.regexes).toHaveLength(1);
    expect(compiled.invalidPatterns).toEqual(["(unclosed"]);
  });

  it("produces no regexes for an empty pattern list", () => {
    const compiled = compileTypoPatterns([]);
    expect(compiled.regexes).toEqual([]);
    expect(compiled.invalidPatterns).toEqual([]);
  });
});

describe("matchTypoPattern", () => {
  it("returns the source of the matching pattern", () => {
    const compiled = compileTypoPatterns([
      "pi-permission-system/packages/pi-permission-system",
    ]);
    const path =
      "/home/x/pi-permission-system/packages/pi-permission-system/src/a.ts";
    expect(matchTypoPattern(path, compiled)).toBe(
      "pi-permission-system/packages/pi-permission-system",
    );
  });

  it("returns the first matching pattern's source when several match", () => {
    const compiled = compileTypoPatterns(["first", "second"]);
    expect(matchTypoPattern("/a/first/second/b", compiled)).toBe("first");
  });

  it("returns undefined when no pattern matches", () => {
    const compiled = compileTypoPatterns(["doubled/doubled"]);
    expect(
      matchTypoPattern("/home/x/pi-packages/src/a.ts", compiled),
    ).toBeUndefined();
  });

  it("returns undefined when there are no patterns", () => {
    const compiled = compileTypoPatterns([]);
    expect(matchTypoPattern("/anything", compiled)).toBeUndefined();
  });

  it("is stateless across repeated calls", () => {
    const compiled = compileTypoPatterns(["segment"]);
    const path = "/a/segment/b";
    expect(matchTypoPattern(path, compiled)).toBe("segment");
    expect(matchTypoPattern(path, compiled)).toBe("segment");
  });
});
