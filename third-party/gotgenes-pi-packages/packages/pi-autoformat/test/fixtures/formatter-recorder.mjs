#!/usr/bin/env node
/**
 * Test-only "formatter" that records every invocation to a JSONL log
 * file pointed at by the PI_AUTOFORMAT_RECORDER_LOG env var.
 *
 * Each line of the log is a JSON object describing one invocation:
 *   { argv: string[], cwd: string, env: { ... } }
 *
 * `argv` contains the arguments after the script path itself, which —
 * for our chain config — is the list of files the formatter was told
 * to process.
 */
import { appendFileSync } from "node:fs";

const logFile = process.env.PI_AUTOFORMAT_RECORDER_LOG;
if (!logFile) {
  console.error("PI_AUTOFORMAT_RECORDER_LOG is not set");
  process.exit(2);
}

const entry = {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
};
appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
