import { MockSession } from "../../adapters/mock/mock";

/** The mock's canonical prompt per scenario id (MockSession.SCENARIOS). A
 *  browser test that needs one scripted scenario sends the constant, so the
 *  routing it relies on is the one mock-scenarios.test.ts proves. */
export const MOCK_PROMPTS = MockSession.prompts as Readonly<
  Record<
    | "markdown-review"
    | "workspace-file-link"
    | "short-document"
    | "live-document"
    | "responsive-document"
    | "document-closure"
    | "action-card"
    | "checklist"
    | "slow-subagent"
    | "subagent"
    | "huge-output"
    | "artifact-broken"
    | "artifact-navigating"
    | "artifact-hostile"
    | "artifact-updating"
    | "artifact"
    | "turn-error"
    | "permission-ask"
    | "notices"
    | "question"
    | "picker"
    | "charts"
    | "console"
    | "tool-activity"
    | "image"
    | "diagram"
    | "stat"
    | "code"
    | "status-list",
    string
  >
>;
