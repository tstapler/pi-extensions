#!/usr/bin/env node
// Regenerate schemas/model-judge.schema.json from the zod source of truth.
// Run via `pnpm run gen:schema`. Never edit the JSON by hand — a parity test
// (test/config-schema.test.ts) fails if the committed file drifts from this.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildModelJudgeJsonSchema } from "../src/config-schema.ts";

const outputPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "schemas",
  "model-judge.schema.json",
);

const json = `${JSON.stringify(buildModelJudgeJsonSchema(), null, 2)}\n`;
writeFileSync(outputPath, json);
console.log(`Wrote ${outputPath}`);
