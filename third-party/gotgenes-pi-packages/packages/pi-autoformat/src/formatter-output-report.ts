import type { FormatterOutputReportingConfig } from "./formatter-config";
import type { BatchRun } from "./formatter-executor";

const HEADER_INDENT = "  ";
const BODY_INDENT = "    ";

type TrimmedStream = {
  /** Lines to render (already byte-trimmed and line-trimmed). */
  lines: string[];
  /** Truncation marker prefix line, or undefined if no truncation happened. */
  marker?: string;
};

function rstripWhitespace(text: string): string {
  // Strip trailing whitespace, including blank trailing lines, but preserve
  // interior empty lines that the formatter intentionally emitted.
  return text.replace(/[\s\uFEFF\xA0]+$/u, "");
}

function snapToNewlineBoundary(buffer: Buffer): Buffer {
  // After tail-slicing on a byte boundary we may sit mid-line and (on
  // multibyte input) mid-character. Advance forward to the first newline so
  // we always start cleanly. If there is no newline, decode-and-cleanup will
  // strip any U+FFFD replacements introduced by a partial UTF-8 sequence at
  // the head.
  const newlineIndex = buffer.indexOf(0x0a);
  if (newlineIndex >= 0) {
    return buffer.subarray(newlineIndex + 1);
  }
  return buffer;
}

function decodeAndCleanup(buffer: Buffer): string {
  const decoded = buffer.toString("utf8");
  // Drop any replacement characters at the head caused by a bisected
  // multibyte sequence. Interior replacements (rare but possible from the
  // formatter itself) are left intact.
  return decoded.replace(/^\uFFFD+/u, "");
}

function trimByBytes(
  text: string,
  maxBytes: number,
): { text: string; droppedBytes: number } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return { text, droppedBytes: 0 };
  }
  const tail = buffer.subarray(buffer.byteLength - maxBytes);
  const snapped = snapToNewlineBoundary(tail);
  const droppedBytes = buffer.byteLength - snapped.byteLength;
  return { text: decodeAndCleanup(snapped), droppedBytes };
}

function trimByLines(
  text: string,
  maxLines: number,
): { lines: string[]; droppedLines: number } {
  const allLines = text.split("\n");
  if (allLines.length <= maxLines) {
    return { lines: allLines, droppedLines: 0 };
  }
  const kept = allLines.slice(allLines.length - maxLines);
  const droppedLines = allLines.length - kept.length;
  return { lines: kept, droppedLines };
}

function trimStream(
  raw: string,
  config: FormatterOutputReportingConfig,
): TrimmedStream | undefined {
  const stripped = rstripWhitespace(raw);
  if (stripped.length === 0) {
    return undefined;
  }

  const byteResult = trimByBytes(stripped, config.maxBytes);
  const lineResult = trimByLines(byteResult.text, config.maxLines);

  let marker: string | undefined;
  if (lineResult.droppedLines > 0) {
    marker = `... (truncated, ${lineResult.droppedLines} earlier lines)`;
  } else if (byteResult.droppedBytes > 0) {
    marker = `... (truncated, ${byteResult.droppedBytes} earlier bytes)`;
  }

  // Lines may include leading empties if the byte-trimmed prefix was a
  // newline. Drop a single leading empty for tidiness.
  const lines =
    lineResult.lines.length > 0 && lineResult.lines[0] === ""
      ? lineResult.lines.slice(1)
      : lineResult.lines;

  if (lines.length === 0 && !marker) {
    return undefined;
  }

  if (marker) {
    return { lines, marker };
  }
  return { lines };
}

function renderBlock(
  label: "stdout" | "stderr",
  stream: TrimmedStream,
): string {
  const lines = [`${HEADER_INDENT}${label}:`];
  if (stream.marker) {
    lines.push(`${BODY_INDENT}${stream.marker}`);
  }
  for (const line of stream.lines) {
    lines.push(`${BODY_INDENT}${line}`);
  }
  return lines.join("\n");
}

export function formatRunOutputBlock(
  run: Pick<BatchRun, "success" | "stdout" | "stderr">,
  config: FormatterOutputReportingConfig,
): string | undefined {
  if (config.onFailure === "none") {
    return undefined;
  }
  if (run.success) {
    return undefined;
  }

  const blocks: string[] = [];

  if (config.onFailure === "both" && run.stdout !== undefined) {
    const trimmed = trimStream(run.stdout, config);
    if (trimmed) {
      blocks.push(renderBlock("stdout", trimmed));
    }
  }

  if (run.stderr !== undefined) {
    const trimmed = trimStream(run.stderr, config);
    if (trimmed) {
      blocks.push(renderBlock("stderr", trimmed));
    }
  }

  if (blocks.length === 0) {
    return undefined;
  }
  return blocks.join("\n");
}
