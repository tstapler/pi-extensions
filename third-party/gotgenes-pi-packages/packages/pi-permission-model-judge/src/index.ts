import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createModelJudgeExtension } from "./extension";

/**
 * Entry point: register the deny-first typo-path model judge as a
 * pi-permission-system Authorizer chain link.
 */
export default function modelJudgeExtension(pi: ExtensionAPI): void {
  createModelJudgeExtension(pi);
}
