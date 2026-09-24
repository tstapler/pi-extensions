import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildModelJudgeJsonSchema,
  modelJudgeConfigSchema,
} from "#src/config-schema";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("buildModelJudgeJsonSchema", () => {
  it("matches the committed schemas/model-judge.schema.json", () => {
    const committed = JSON.parse(
      readFileSync(
        join(packageRoot, "schemas", "model-judge.schema.json"),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    expect(committed).toEqual(buildModelJudgeJsonSchema());
  });
});

describe("config/config.example.json", () => {
  it("validates against the schema", () => {
    const example = JSON.parse(
      readFileSync(join(packageRoot, "config", "config.example.json"), "utf-8"),
    ) as Record<string, unknown>;
    const { $schema: _schema, ...rest } = example;
    const result = modelJudgeConfigSchema.safeParse(rest);
    expect(result.success).toBe(true);
  });
});
