export const extensionName = "pi-autoformat";

export {
  AUTOFORMAT_CONFIG_FILE_NAME,
  AUTOFORMAT_EXTENSION_ID,
  type ConfigValidationIssue,
  getGlobalConfigPath,
  getProjectConfigPath,
  type LoadConfigResult,
  loadAutoformatConfig,
  type ValidateConfigResult,
  validateUserFormatterConfig,
} from "./config-loader";
export {
  createAutoformatExtension,
  default as autoformatExtension,
} from "./extension";
export {
  type FormatScope,
  type FormatScopeSetting,
  isInFormatScope,
  resolveFormatScope,
} from "./format-scope";
export {
  type AutoformatConfig,
  createFormatterConfig,
  DEFAULT_FORMATTER_CONFIG,
  type UserFormatterConfig,
} from "./formatter-config";
export {
  type BatchRun,
  type ChainGroupInput,
  type CommandRunner,
  type CommandRunnerOptions,
  type CommandRunResult,
  executeChainGroup,
} from "./formatter-executor";
export {
  type ChainGroup,
  type FormatterConfig,
  type FormatterDefinition,
  groupFilesByChain,
  type ResolvedFormatter,
  resolveChain,
} from "./formatter-registry";
export {
  type ChainGroupResult,
  PromptAutoformatter,
  type PromptAutoformatterResult,
} from "./prompt-autoformatter";
export {
  DEFAULT_SHELL_MUTATION_DETECTION,
  matchWrapper,
  parseKnownCommand,
  type ShellMutationDetectionConfig,
  SnapshotTracker,
  type WrapperConfig,
} from "./shell-mutation-detector";
export {
  type MutationSourceHandler,
  TouchedFilesQueue,
  writeOrEditHandler,
} from "./touched-files-queue";
