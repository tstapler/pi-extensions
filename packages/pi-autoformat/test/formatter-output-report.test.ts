import { describe, expect, it } from "vitest";
import type { FormatterOutputReportingConfig } from "#src/formatter-config";
import type { BatchRun } from "#src/formatter-executor";
import { formatRunOutputBlock } from "#src/formatter-output-report";

const ENABLED_STDERR: FormatterOutputReportingConfig = {
  onFailure: "stderr",
  maxBytes: 4096,
  maxLines: 40,
};

const ENABLED_BOTH: FormatterOutputReportingConfig = {
  onFailure: "both",
  maxBytes: 4096,
  maxLines: 40,
};

const DISABLED: FormatterOutputReportingConfig = {
  onFailure: "none",
  maxBytes: 4096,
  maxLines: 40,
};

function failedRun(overrides: Partial<BatchRun> = {}): BatchRun {
  return {
    formatterName: "prettier",
    command: ["prettier", "--write", "src/foo.ts"],
    files: ["src/foo.ts"],
    success: false,
    exitCode: 2,
    ...overrides,
  };
}

describe("formatRunOutputBlock", () => {
  it("returns undefined when onFailure is none", () => {
    const block = formatRunOutputBlock(
      failedRun({ stderr: "boom\n" }),
      DISABLED,
    );
    expect(block).toBeUndefined();
  });

  it("returns undefined for successful runs even when enabled", () => {
    const block = formatRunOutputBlock(
      failedRun({ success: true, exitCode: 0, stderr: "noisy success" }),
      ENABLED_BOTH,
    );
    expect(block).toBeUndefined();
  });

  it("returns undefined when both streams are empty / whitespace", () => {
    const block = formatRunOutputBlock(
      failedRun({ stdout: "  \n  ", stderr: "" }),
      ENABLED_BOTH,
    );
    expect(block).toBeUndefined();
  });

  it("returns undefined when stderr-only mode has no stderr", () => {
    const block = formatRunOutputBlock(
      failedRun({ stdout: "lots of stdout" }),
      ENABLED_STDERR,
    );
    expect(block).toBeUndefined();
  });

  it("renders only stderr under onFailure: stderr", () => {
    const block = formatRunOutputBlock(
      failedRun({ stdout: "ignored", stderr: "line one\nline two" }),
      ENABLED_STDERR,
    );
    expect(block).toBe(
      ["  stderr:", "    line one", "    line two"].join("\n"),
    );
  });

  it("renders stdout above stderr under onFailure: both", () => {
    const block = formatRunOutputBlock(
      failedRun({ stdout: "out one\nout two", stderr: "err one" }),
      ENABLED_BOTH,
    );
    expect(block).toBe(
      [
        "  stdout:",
        "    out one",
        "    out two",
        "  stderr:",
        "    err one",
      ].join("\n"),
    );
  });

  it("omits the stdout block when stdout is empty under onFailure: both", () => {
    const block = formatRunOutputBlock(
      failedRun({ stdout: "", stderr: "err only" }),
      ENABLED_BOTH,
    );
    expect(block).toBe(["  stderr:", "    err only"].join("\n"));
  });

  it("strips trailing whitespace before rendering", () => {
    const block = formatRunOutputBlock(
      failedRun({ stderr: "useful line\n\n   \n" }),
      ENABLED_STDERR,
    );
    expect(block).toBe(["  stderr:", "    useful line"].join("\n"));
  });

  it("truncates by line count and reports how many earlier lines were dropped", () => {
    const stderr = Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join(
      "\n",
    );
    const block = formatRunOutputBlock(failedRun({ stderr }), {
      onFailure: "stderr",
      maxBytes: 65536,
      maxLines: 5,
    });
    expect(block).toBeDefined();
    const lines = (block ?? "").split("\n");
    expect(lines[0]).toBe("  stderr:");
    expect(lines[1]).toBe("    ... (truncated, 45 earlier lines)");
    expect(lines.slice(2)).toEqual([
      "    line46",
      "    line47",
      "    line48",
      "    line49",
      "    line50",
    ]);
  });

  it("truncates by byte cap and snaps forward to a newline boundary", () => {
    // 10 lines, each 100 bytes -> ~1000 bytes total; cap at 250 bytes.
    const stderr = Array.from(
      { length: 10 },
      (_, i) => `${String(i).padStart(2, "0")}-${"x".repeat(96)}`,
    ).join("\n");
    const block = formatRunOutputBlock(failedRun({ stderr }), {
      onFailure: "stderr",
      maxBytes: 250,
      maxLines: 100,
    });
    expect(block).toBeDefined();
    const lines = (block ?? "").split("\n");
    expect(lines[0]).toBe("  stderr:");
    expect(lines[1]).toMatch(/^ {4}\.\.\. \(truncated, \d+ earlier bytes\)$/);
    // Only the tail lines survive; the first line ("00-…") must be gone.
    expect(block).not.toContain("00-x");
    expect(block).toContain("09-x");
  });

  it("does not bisect a multibyte UTF-8 character at the byte boundary", () => {
    // Each emoji is 4 bytes in UTF-8. Keep last ~10 bytes after a long prefix.
    const head = "x".repeat(100);
    const tail = "🌟🌟🌟"; // 12 bytes
    const stderr = `${head}\n${tail}`;
    const block = formatRunOutputBlock(failedRun({ stderr }), {
      onFailure: "stderr",
      maxBytes: 14,
      maxLines: 100,
    });
    expect(block).toBeDefined();
    // Whatever survived must be valid UTF-8 (round-tripping through Buffer
    // preserves bytes; a bisected sequence would render as U+FFFD).
    expect(block).not.toContain("\uFFFD");
    expect(block).toContain("🌟");
  });

  it("leaves output unchanged when both caps are well above the content size", () => {
    const stderr = "short and tidy";
    const block = formatRunOutputBlock(failedRun({ stderr }), {
      onFailure: "stderr",
      maxBytes: 10_000,
      maxLines: 100,
    });
    expect(block).toBe(["  stderr:", "    short and tidy"].join("\n"));
  });
});
