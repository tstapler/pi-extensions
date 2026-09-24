import { describe, expect, it, vi } from "vitest";

import {
  matchWrapper,
  parseKnownCommand,
  SnapshotTracker,
} from "#src/shell-mutation-detector";

describe("parseKnownCommand", () => {
  describe("sed -i", () => {
    it("extracts a single target", () => {
      expect(parseKnownCommand("sed -i 's/a/b/' foo.txt")).toEqual(["foo.txt"]);
    });

    it("extracts multiple targets", () => {
      expect(parseKnownCommand("sed -i 's/a/b/' foo.txt bar.txt")).toEqual([
        "foo.txt",
        "bar.txt",
      ]);
    });

    it("handles -i.bak suffix without reporting the backup", () => {
      expect(parseKnownCommand("sed -i.bak 's/a/b/' foo.txt")).toEqual([
        "foo.txt",
      ]);
    });

    it("handles BSD sed -i '' form", () => {
      expect(parseKnownCommand("sed -i '' 's/a/b/' foo.txt")).toEqual([
        "foo.txt",
      ]);
    });

    it("returns empty when -i is absent", () => {
      expect(parseKnownCommand("sed 's/a/b/' foo.txt")).toEqual([]);
    });

    it("bails on unknown sed flags", () => {
      expect(parseKnownCommand("sed -i -X 's/a/b/' foo.txt")).toEqual([]);
    });
  });

  describe("mv / cp", () => {
    it("returns the destination of mv", () => {
      expect(parseKnownCommand("mv a.txt b.txt")).toEqual(["b.txt"]);
    });

    it("returns the destination of cp", () => {
      expect(parseKnownCommand("cp a.txt b.txt")).toEqual(["b.txt"]);
    });

    it("bails on multi-source mv", () => {
      expect(parseKnownCommand("mv a.txt b.txt c/")).toEqual([]);
    });

    it("bails on unknown flags", () => {
      expect(
        parseKnownCommand("mv --strip-trailing-slash a.txt b.txt"),
      ).toEqual([]);
    });
  });

  describe("touch", () => {
    it("returns each file argument", () => {
      expect(parseKnownCommand("touch a.txt b.txt")).toEqual([
        "a.txt",
        "b.txt",
      ]);
    });

    it("accepts allowlisted flags", () => {
      expect(parseKnownCommand("touch -a -m foo.txt")).toEqual(["foo.txt"]);
    });

    it("bails on -r / -t / -d", () => {
      expect(parseKnownCommand("touch -r ref.txt foo.txt")).toEqual([]);
    });
  });

  describe("redirections", () => {
    it("captures > target alongside echo", () => {
      expect(parseKnownCommand("echo hi > out.txt")).toEqual(["out.txt"]);
    });

    it("captures >> append redirection", () => {
      expect(parseKnownCommand("printf 'x' >> out.txt")).toEqual(["out.txt"]);
    });

    it("ignores redirects on unknown commands", () => {
      expect(parseKnownCommand("foo --bar > out.txt")).toEqual([]);
    });
  });

  describe("tee", () => {
    it("captures tee targets", () => {
      expect(parseKnownCommand("tee a.txt b.txt")).toEqual(["a.txt", "b.txt"]);
    });
    it("captures tee -a", () => {
      expect(parseKnownCommand("tee -a a.txt")).toEqual(["a.txt"]);
    });
  });

  describe("bails on complex constructs", () => {
    const cases = [
      "sed -i 's/a/b/' foo.txt | tee log.txt",
      "echo hi && touch foo.txt",
      "echo $(cat names.txt) > out.txt",
      "echo `pwd` > out.txt",
      "(touch foo.txt)",
      "cat <input.txt > out.txt",
      "echo hi; touch foo.txt",
    ];
    for (const command of cases) {
      it(`returns [] for ${JSON.stringify(command)}`, () => {
        expect(parseKnownCommand(command)).toEqual([]);
      });
    }
  });

  it("returns [] on completely unknown commands", () => {
    expect(parseKnownCommand("rsync -a src/ dst/")).toEqual([]);
  });

  it("handles quoted paths with spaces", () => {
    expect(parseKnownCommand("touch 'my file.txt'")).toEqual(["my file.txt"]);
    expect(parseKnownCommand('touch "my file.txt"')).toEqual(["my file.txt"]);
  });
});

describe("matchWrapper", () => {
  it("returns paths from stdout when prefix matches", () => {
    expect(
      matchWrapper(
        "pnpm codegen --foo",
        "src/generated/a.ts\nsrc/generated/b.ts\n",
        [{ prefix: "pnpm codegen" }],
      ),
    ).toEqual(["src/generated/a.ts", "src/generated/b.ts"]);
  });

  it("returns [] when no wrapper matches", () => {
    expect(
      matchWrapper("pnpm test", "ignored", [{ prefix: "pnpm codegen" }]),
    ).toEqual([]);
  });

  it("matches exact prefix without arguments", () => {
    expect(
      matchWrapper("make gen", "out.ts\n", [{ prefix: "make gen" }]),
    ).toEqual(["out.ts"]);
  });

  it("trims surrounding whitespace and skips blank lines", () => {
    expect(
      matchWrapper("pnpm codegen", "  a.ts  \n\n  b.ts\n", [
        { prefix: "pnpm codegen" },
      ]),
    ).toEqual(["a.ts", "b.ts"]);
  });
});

describe("SnapshotTracker", () => {
  it("reports files whose mtime advanced", () => {
    const mtimes = new Map<string, number>([
      ["/repo/a.ts", 100],
      ["/repo/b.ts", 200],
    ]);
    const tracker = new SnapshotTracker({
      cwd: "/repo",
      globs: ["**/*.ts"],
      resolveGlobs: () => ["/repo/a.ts", "/repo/b.ts"],
      stat: (p) => {
        const m = mtimes.get(p);
        return m === undefined ? undefined : { mtimeMs: m };
      },
    });
    tracker.before();
    mtimes.set("/repo/a.ts", 150);
    expect(tracker.after()).toEqual(["/repo/a.ts"]);
  });

  it("ignores files whose mtime did not change", () => {
    const tracker = new SnapshotTracker({
      cwd: "/repo",
      globs: ["**/*.ts"],
      resolveGlobs: () => ["/repo/a.ts"],
      stat: () => ({ mtimeMs: 100 }),
    });
    tracker.before();
    expect(tracker.after()).toEqual([]);
  });

  it("reports newly created files", () => {
    let exists = false;
    const tracker = new SnapshotTracker({
      cwd: "/repo",
      globs: ["**/*.ts"],
      resolveGlobs: () => ["/repo/new.ts"],
      stat: () => (exists ? { mtimeMs: 500 } : undefined),
    });
    tracker.before();
    exists = true;
    expect(tracker.after()).toEqual(["/repo/new.ts"]);
  });

  it("warns when the cap is exceeded", () => {
    const onWarn = vi.fn();
    const files = Array.from({ length: 10 }, (_, i) => `/repo/${i}.ts`);
    const tracker = new SnapshotTracker({
      cwd: "/repo",
      globs: ["**/*.ts"],
      resolveGlobs: () => files,
      stat: () => ({ mtimeMs: 100 }),
      maxEntries: 3,
      onWarn,
    });
    tracker.before();
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]?.[0]).toMatch(/truncated/);
  });
});
