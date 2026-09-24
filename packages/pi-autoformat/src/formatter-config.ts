import type { CustomMutationToolSpec } from "./custom-mutation-tools";
import type { FormatScopeSetting } from "./format-scope";
import type {
  ChainStep,
  FormatterConfig,
  FormatterDefinition,
} from "./formatter-registry";
import {
  DEFAULT_SHELL_MUTATION_DETECTION,
  type ShellMutationDetectionConfig,
} from "./shell-mutation-detector";

export type FormatterOutputOnFailure = "none" | "stderr" | "both";

export type FormatterOutputReportingConfig = {
  /** Which streams to include for *failed* runs. Default: "none". */
  onFailure: FormatterOutputOnFailure;
  /** Hard byte cap per stream per run (UTF-8 byte length). */
  maxBytes: number;
  /** Hard line cap per stream per run, applied after byte trimming. */
  maxLines: number;
};

export const DEFAULT_FORMATTER_OUTPUT_REPORTING: FormatterOutputReportingConfig =
  {
    onFailure: "none",
    maxBytes: 4096,
    maxLines: 40,
  };

export type EventBusMutationChannelConfig = {
  enabled: boolean;
  channel: string;
};

export const DEFAULT_EVENT_BUS_MUTATION_CHANNEL: EventBusMutationChannelConfig =
  {
    enabled: true,
    channel: "autoformat:touched",
  };

export type UserFormatterConfig = {
  commandTimeoutMs?: number;
  hideSummariesInTui?: boolean;
  formatScope?: FormatScopeSetting;
  shellMutationDetection?: Partial<ShellMutationDetectionConfig>;
  customMutationTools?: CustomMutationToolSpec[];
  eventBusMutationChannel?: Partial<EventBusMutationChannelConfig>;
  formatters?: Record<string, FormatterDefinition>;
  chains?: Record<string, ChainStep[]>;
  formatterOutput?: Partial<FormatterOutputReportingConfig>;
};

export type AutoformatConfig = FormatterConfig & {
  commandTimeoutMs: number;
  hideSummariesInTui: boolean;
  formatScope: FormatScopeSetting;
  shellMutationDetection: ShellMutationDetectionConfig;
  customMutationTools: CustomMutationToolSpec[];
  eventBusMutationChannel: EventBusMutationChannelConfig;
  formatters: Record<string, FormatterDefinition>;
  chains: Record<string, ChainStep[]>;
  formatterOutput: FormatterOutputReportingConfig;
};

export const DEFAULT_FORMATTER_CONFIG: AutoformatConfig = {
  commandTimeoutMs: 10000,
  hideSummariesInTui: false,
  formatScope: "repoRoot",
  shellMutationDetection: DEFAULT_SHELL_MUTATION_DETECTION,
  customMutationTools: [],
  eventBusMutationChannel: DEFAULT_EVENT_BUS_MUTATION_CHANNEL,
  formatters: {
    prettier: {
      command: ["prettier", "--write"],
    },
    "markdownlint-cli2": {
      command: ["markdownlint-cli2", "--fix"],
    },
  },
  formatterOutput: DEFAULT_FORMATTER_OUTPUT_REPORTING,
  chains: {},
};

export function createFormatterConfig(
  userConfig?: UserFormatterConfig,
): AutoformatConfig {
  return {
    commandTimeoutMs:
      userConfig?.commandTimeoutMs ?? DEFAULT_FORMATTER_CONFIG.commandTimeoutMs,
    hideSummariesInTui:
      userConfig?.hideSummariesInTui ??
      DEFAULT_FORMATTER_CONFIG.hideSummariesInTui,
    formatScope:
      userConfig?.formatScope ?? DEFAULT_FORMATTER_CONFIG.formatScope,
    shellMutationDetection: {
      ...DEFAULT_FORMATTER_CONFIG.shellMutationDetection,
      ...userConfig?.shellMutationDetection,
    },
    customMutationTools:
      userConfig?.customMutationTools ??
      DEFAULT_FORMATTER_CONFIG.customMutationTools,
    eventBusMutationChannel: {
      ...DEFAULT_FORMATTER_CONFIG.eventBusMutationChannel,
      ...userConfig?.eventBusMutationChannel,
    },
    formatters: {
      ...DEFAULT_FORMATTER_CONFIG.formatters,
      ...userConfig?.formatters,
    },
    chains: userConfig?.chains ?? {},
    formatterOutput: {
      ...DEFAULT_FORMATTER_CONFIG.formatterOutput,
      ...userConfig?.formatterOutput,
    },
  };
}
