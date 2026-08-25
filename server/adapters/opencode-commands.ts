import type { PromptOption, SessionMsg } from "../protocol";
import { emitPromptOptions, errText } from "./types";
import { emitModelPicker } from "./model-picker";
import { runSlashTurn } from "./wire-helpers";
import type {
  OpenCodeAgentEntry,
  OpenCodeCommandEntry,
  OpenCodeModelEntry,
} from "./opencode-client";

type Emit = (message: SessionMsg) => void;

// OpenCode's TUI default primary agent — what runs before any explicit pick.
export const OPENCODE_DEFAULT_AGENT = "build";

/** `/model` + `/agent` are Mirafold's own re-skins (no source badge); the
 *  engine's command catalog rides behind them, badged `opencode` because the
 *  descriptions are the engine's/user's own text. */
export function opencodeSlashOptions(engineCommands: OpenCodeCommandEntry[]): PromptOption[] {
  return [
    {
      trigger: "/",
      value: "/model",
      label: "model",
      description: "choose what model to use",
      kind: "command",
    },
    {
      trigger: "/",
      value: "/agent",
      label: "agent",
      description: "switch the OpenCode agent (build, plan, …)",
      kind: "command",
    },
    ...engineCommands.map(
      (command): PromptOption => ({
        trigger: "/",
        value: `/${command.name}`,
        label: command.name,
        ...(command.description ? { description: command.description } : {}),
        kind: "command",
        source: "opencode",
      }),
    ),
  ];
}

export function runOpenCodeModelCommand(options: {
  arg: string;
  emit: Emit;
  /** Models of ALLOWED providers only — the picker never offers a row the
   *  policy would refuse; a typed blocked pick still refuses with its reason
   *  through `setModel`. */
  listModels: () => Promise<OpenCodeModelEntry[]>;
  isCurrent: (providerID: string, modelID: string) => boolean;
  /** Resolves to a refusal/usage reason, or undefined on success. */
  setModel: (id: string) => Promise<string | undefined>;
}): Promise<void> {
  const { arg, emit, listModels, isCurrent, setModel } = options;
  return runSlashTurn(emit, async () => {
    if (arg === "") {
      let models: OpenCodeModelEntry[];
      try {
        models = await listModels();
      } catch (error) {
        emit({
          type: "error",
          message: `Could not read the model list from opencode: ${errText(error)}`,
        });
        return;
      }
      emitModelPicker(
        emit,
        models.map((model) => ({
          id: `${model.providerID}/${model.modelID}`,
          displayName: `${model.providerID}/${model.modelID}`,
          description: model.name && model.name !== model.modelID ? model.name : "",
          current: isCurrent(model.providerID, model.modelID),
        })),
        {
          clickText: (id) => `/model ${id}`,
          switchHint: "Send `/model <provider>/<model>` to switch.",
        },
      );
    } else if (/\s/.test(arg) || arg.startsWith("-")) {
      emit({ type: "text_delta", text: "Usage: `/model` to pick, or `/model <provider>/<model>`." });
    } else {
      const reason = await setModel(arg);
      if (reason) emit({ type: "error", message: reason });
      else emit({ type: "text_delta", text: `Model set to ${arg}.` });
    }
  });
}

export function runOpenCodeAgentCommand(options: {
  arg: string;
  emit: Emit;
  listAgents: () => Promise<OpenCodeAgentEntry[]>;
  currentAgent: string;
  setAgent: (name: string) => void;
}): Promise<void> {
  const { arg, emit, listAgents, currentAgent, setAgent } = options;
  return runSlashTurn(emit, async () => {
    let agents: OpenCodeAgentEntry[];
    try {
      agents = (await listAgents()).filter((a) => a.mode === "primary" && !a.hidden);
    } catch (error) {
      emit({
        type: "error",
        message: `Could not read the agent list from opencode: ${errText(error)}`,
      });
      return;
    }
    if (arg === "") {
      emitModelPicker(
        emit,
        agents.map((agent) => ({
          id: agent.name,
          displayName: agent.name,
          description: agent.description ?? "",
          current: agent.name === currentAgent,
        })),
        {
          clickText: (id) => `/agent ${id}`,
          switchHint: "Send `/agent <name>` to switch.",
          question: "Select an agent",
        },
      );
    } else if (agents.some((a) => a.name === arg)) {
      setAgent(arg);
      emit({ type: "text_delta", text: `Agent set to ${arg}.` });
    } else {
      emit({
        type: "text_delta",
        text: `Usage: \`/agent\` to pick, or \`/agent <name>\` (${agents.map((a) => a.name).join(", ")}).`,
      });
    }
  });
}

export function refreshOpenCodePromptOptions(options: {
  emit: Emit;
  listCommands: () => Promise<OpenCodeCommandEntry[]>;
  isClosed: () => boolean;
}): void {
  // The Mirafold re-skins are useful immediately; the engine catalog fills
  // in asynchronously (and its absence costs only those rows).
  emitPromptOptions(options.emit, opencodeSlashOptions([]));
  options
    .listCommands()
    .then((commands) => {
      if (options.isClosed() || !commands.length) return;
      emitPromptOptions(options.emit, opencodeSlashOptions(commands));
    })
    .catch(() => {});
}
