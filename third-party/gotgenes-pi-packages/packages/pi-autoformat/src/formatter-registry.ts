import path from "node:path";

import {
  type BuiltinFormatter,
  getBuiltinFormatter,
} from "./builtin-formatters";

export type FormatterDefinition = {
  command: string[];
  environment?: Record<string, string>;
  disabled?: boolean;
};

export type FallbackChainStep = {
  fallback: string[];
};

export type ChainStep = string | FallbackChainStep;

export type FormatterConfig = {
  formatters: Record<string, FormatterDefinition>;
  chains?: Record<string, ChainStep[]>;
};

export type ResolvedFormatter = {
  name: string;
  command: string[];
  environment?: Record<string, string>;
  builtin?: BuiltinFormatter;
};

export type ResolvedSingleStep = {
  kind: "single";
  formatter: ResolvedFormatter;
};

export type ResolvedFallbackStep = {
  kind: "fallback";
  alternatives: ResolvedFormatter[];
};

export type ResolvedChainStep = ResolvedSingleStep | ResolvedFallbackStep;

export type ChainGroup = {
  chain: ChainStep[];
  files: string[];
};

function encodeChainStep(step: ChainStep): string {
  if (typeof step === "string") {
    return `S:${step}`;
  }
  return `F:${step.fallback.join("|")}`;
}

function encodeChain(chain: ChainStep[]): string {
  return chain.map(encodeChainStep).join("\u0000");
}

export const WILDCARD_CHAIN_KEY = "*";

export function groupFilesByChain(
  files: string[],
  config: FormatterConfig,
): ChainGroup[] {
  const groups: ChainGroup[] = [];
  const indexByKey = new Map<string, number>();

  const wildcardChain = config.chains?.[WILDCARD_CHAIN_KEY];
  if (wildcardChain && wildcardChain.length > 0 && files.length > 0) {
    groups.push({ chain: [...wildcardChain], files: [...files] });
    indexByKey.set(`W:${encodeChain(wildcardChain)}`, 0);
  }

  for (const filePath of files) {
    const extension = path.extname(filePath).toLowerCase();
    if (!extension) {
      continue;
    }
    const chainSteps = config.chains?.[extension];
    if (!chainSteps || chainSteps.length === 0) {
      continue;
    }
    const key = `E:${encodeChain(chainSteps)}`;
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, groups.length);
      groups.push({ chain: [...chainSteps], files: [filePath] });
    } else {
      groups[existingIndex].files.push(filePath);
    }
  }

  return groups;
}

export function resolveChain(
  chainNames: string[],
  config: FormatterConfig,
): ResolvedFormatter[] {
  const resolved: ResolvedFormatter[] = [];
  for (const name of chainNames) {
    const formatter = resolveFormatterByName(name, config);
    if (formatter) {
      resolved.push(formatter);
    }
  }
  return resolved;
}

function resolveFormatterByName(
  name: string,
  config: FormatterConfig,
): ResolvedFormatter | undefined {
  const formatter = config.formatters[name];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- formatter lookup may return undefined despite indexed access type
  if (formatter) {
    if (formatter.disabled) {
      return undefined;
    }
    return {
      name,
      command: [...formatter.command],
      environment: formatter.environment,
    };
  }
  const builtin = getBuiltinFormatter(name);
  if (builtin) {
    return {
      name,
      // Built-ins build their argv at execution time from the discovered
      // config root. The placeholder here is replaced by the executor.
      command: [builtin.name],
      builtin,
    };
  }
  return undefined;
}

export function resolveChainSteps(
  steps: ChainStep[],
  config: FormatterConfig,
): ResolvedChainStep[] {
  const resolved: ResolvedChainStep[] = [];
  for (const step of steps) {
    if (typeof step === "string") {
      const formatter = resolveFormatterByName(step, config);
      if (formatter) {
        resolved.push({ kind: "single", formatter });
      }
      continue;
    }
    const alternatives: ResolvedFormatter[] = [];
    for (const name of step.fallback) {
      const formatter = resolveFormatterByName(name, config);
      if (formatter) {
        alternatives.push(formatter);
      }
    }
    if (alternatives.length > 0) {
      resolved.push({ kind: "fallback", alternatives });
    }
  }
  return resolved;
}
