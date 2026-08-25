import type { ModelReasoningEffort } from "@openai/codex-sdk";
import { runSlashTurn } from "./wire-helpers";
import type { PromptOption, SessionMsg } from "../protocol";
import { emitPromptOptions } from "./types";
import type { CodexModel } from "./codex-model-list";
import { emitModelPicker } from "./model-picker";
import { codexSlashOptions } from "./codex-prompt-options";
import type { CodexSkill } from "./codex-skills-list";

type Emit = (message: SessionMsg) => void;

export type CodexReasoningEffort = ModelReasoningEffort | "none";
// Internal-only: the model/config default remains in force until a user pick.
export const CODEX_EFFORT_STAND_IN = "default";

const EFFORTS: readonly ModelReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
// Codex forwards `none` to discovered local Responses endpoints even though
// the SDK's published TypeScript union does not yet include it.
const LOCAL_EFFORTS: readonly CodexReasoningEffort[] = ["none", ...EFFORTS];
const EFFORT_DESCRIPTIONS: Record<CodexReasoningEffort, string> = {
  none: "Disable model reasoning (when supported)",
  minimal: "Least reasoning, fastest",
  low: "Light reasoning",
  medium: "Balanced reasoning",
  high: "Deep reasoning",
  xhigh: "Maximum reasoning, slowest",
};

const isEffort = (
  value: string,
  efforts: readonly CodexReasoningEffort[],
): value is CodexReasoningEffort => (efforts as readonly string[]).includes(value);

export function runCodexModelCommand(options: {
  arg: string;
  emit: Emit;
  listModels: () => Promise<CodexModel[]>;
  isCurrent: (model: CodexModel) => boolean;
  setModel: (model: string) => void;
  diagnostic: (error: unknown) => string;
}): Promise<void> {
  const { arg, emit, listModels, isCurrent, setModel, diagnostic } = options;
  return runSlashTurn(emit, async () => {
    if (arg === "") {
      let models: CodexModel[];
      try {
        models = await listModels();
      } catch (error) {
        emit({
          type: "error",
          message: `Could not read the model list from codex: ${diagnostic(error)}`,
        });
        return;
      }
      emitModelPicker(
        emit,
        models.map((model) => ({ ...model, current: isCurrent(model) })),
        {
          clickText: (id) => `/model ${id}`,
          switchHint: "Send `/model <model-id>` to switch.",
        },
      );
      emit({
        type: "text_delta",
        text: "\nLegacy models can be set directly with `/model <model_name>`.",
      });
    } else if (/\s/.test(arg) || arg.startsWith("-")) {
      // Reject flag-shaped values locally instead of relying on Codex's CLI
      // parser to interpret a --model argument safely.
      emit({ type: "text_delta", text: "Usage: `/model` to pick, or `/model <model-id>`." });
    } else {
      setModel(arg);
      emit({ type: "text_delta", text: `Model set to ${arg}.` });
    }
  });
}

export function runCodexEffortCommand(options: {
  arg: string;
  emit: Emit;
  discoveredLocalEndpoint: boolean;
  currentEffort: string;
  setEffort: (effort: CodexReasoningEffort) => void;
}): Promise<void> {
  const { arg, emit, discoveredLocalEndpoint, currentEffort, setEffort } = options;
  return runSlashTurn(emit, () => {
    const efforts = discoveredLocalEndpoint ? LOCAL_EFFORTS : EFFORTS;
    if (arg === "") {
      emitModelPicker(
        emit,
        efforts.map((effort) => ({
          id: effort,
          displayName: effort,
          description: EFFORT_DESCRIPTIONS[effort],
          current: currentEffort === effort,
        })),
        {
          clickText: (id) => `/effort ${id}`,
          switchHint: "Send `/effort <level>` to set the reasoning effort.",
          question: "Select reasoning effort",
        },
      );
    } else if (isEffort(arg, efforts)) {
      setEffort(arg);
      emit({ type: "text_delta", text: `Reasoning effort set to ${arg}.` });
    } else {
      emit({
        type: "text_delta",
        text: `Usage: \`/effort\` to pick, or \`/effort <level>\` (${efforts.join(", ")}).`,
      });
    }
  });
}

export function refreshCodexPromptOptions(options: {
  emit: Emit;
  listSkills: () => Promise<CodexSkill[]>;
  isClosed: () => boolean;
}): void {
  const slash = codexSlashOptions();
  emitPromptOptions(options.emit, slash);
  options
    .listSkills()
    .then((skills) => {
      if (options.isClosed()) return;
      const skillOptions: PromptOption[] = skills.map((skill) => ({
        trigger: "$",
        value: `$${skill.name}`,
        label: skill.name,
        description: skill.description,
        kind: "skill",
        source: "codex",
      }));
      emitPromptOptions(options.emit, [...slash, ...skillOptions]);
    })
    .catch(() => {}); // slash commands remain useful if skill discovery is unavailable
}
