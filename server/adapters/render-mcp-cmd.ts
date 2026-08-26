import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionMsg } from "../protocol";
import { resolveImageProps } from "../render-image";
import { clientSchemas, type ComponentName } from "../registry-spec";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The server name the adapters register the render MCP under — it's how
 *  their event streams recognize our tool calls among the agent's own. */
export const MIRAFOLD_MCP = "mirafold";

/** render_* tool name → the registry component a call to it paints — the ONE
 *  list of the agent-authorable vocabulary. Both tool servers (render-tools.ts
 *  in-process, render-mcp.ts stdio) derive their registrations from it, so a
 *  new component can't land in one transport and not the other. */
export const RENDER_TOOL_COMPONENT = {
  render_card: "card",
  render_list: "list",
  render_table: "table",
  render_chart: "chart",
  render_links: "link-group",
  render_keyvalue: "key-value",
  render_progress: "progress",
  render_timeline: "timeline",
  render_filetree: "file-tree",
  render_question: "question",
  render_diff: "diff",
  render_stat: "stat",
  render_code: "code",
  render_statuslist: "status-list",
  render_console: "console",
  render_image: "image",
  render_diagram: "diagram",
} as const satisfies Record<string, ComponentName>;

export type RenderToolName = keyof typeof RENDER_TOOL_COMPONENT;

export const renderToolEntries = Object.entries(RENDER_TOOL_COMPONENT) as [
  RenderToolName,
  ComponentName,
][];

/** Matches the component id inside the render-MCP stub's ack text
 *  ("Rendered card (id: …)") — the fallback channel when an engine drops
 *  structured content. The id is the agent's own choice within
 *  RENDER_ID_GRAMMAR (`render_progress({id:"deploy-status"})` is the
 *  documented update-in-place idiom), not only a uuid. */
export const RENDER_ID_RE = /\(id:\s*([^\s)]+)\)/;

/** The one grammar for an agent-chosen render/artifact id, stated to the
 *  model in RENDER_GUIDANCE and enforced wherever an id enters the shell:
 *  the in-process render server (Claude Code), the stdio stub's ack, and
 *  `renderIdFor` on every stdio adapter. The shell keys paintings, the
 *  replay ring, and the checkpoint by this id, so it is bounded and plain;
 *  anything else gets a fresh uuid — the agent loses update-in-place for
 *  that call, the shell never keys on hostile data (2026-08-26). */
export const RENDER_ID_GRAMMAR = "1–128 characters from letters, digits, `_`, `.`, `:`, `-`";
const RENDER_ID_OK = /^[A-Za-z0-9_.:-]{1,128}$/;
export const acceptableRenderId = (v: unknown): string | undefined =>
  typeof v === "string" && RENDER_ID_OK.test(v) ? v : undefined;
const acceptableId = acceptableRenderId;

/**
 * The ONE precedence for the component id a Mirafold render call paints
 * under, shared by every adapter that watches a stdio-MCP engine: the stub's
 * structured ack (what it assigned), then the id the agent passed in the
 * call's arguments (what it will re-send for an update-in-place), then the
 * regex over the ack prose (the least reliable channel), then a fresh uuid.
 * The stub acks with the agent's own id when one was passed, so in practice
 * the channels agree; the order only decides who wins if an engine mangles
 * one of them.
 */
export function renderIdFor(source: {
  structured?: unknown;
  argId?: unknown;
  ackText?: unknown;
}): string {
  const structured = source.structured as { renderId?: unknown } | undefined;
  const match = RENDER_ID_RE.exec(String(source.ackText ?? ""));
  return (
    acceptableId(structured?.renderId) ??
    acceptableId(source.argId) ??
    acceptableId(match?.[1]) ??
    randomUUID()
  );
}

/**
 * The render/artifact WireMsg a Mirafold MCP tool call stands for:
 * the stub only validated the args and returned the id — the adapter watching
 * the agent's own event stream paints the message here. Returns null for an
 * unknown Mirafold MCP tool (ignore rather than paint junk).
 */
// `workspaceDir` is REQUIRED for the same reason it is on makeRenderServer:
// it jails the image tool's read. Making it optional
// would let a future adapter skip containment by simply forgetting it.
export function generativeUIMsg(
  tool: string,
  params: Record<string, unknown>,
  id: string,
  workspaceDir: string,
): SessionMsg | null {
  let props = { ...params };
  delete props["id"];
  if (tool === "emit_artifact") {
    return {
      type: "artifact",
      html: typeof props["html"] === "string" ? (props["html"] as string) : "",
      id,
      title: typeof props["title"] === "string" ? (props["title"] as string) : undefined,
    };
  }
  const component = (RENDER_TOOL_COMPONENT as Record<string, ComponentName | undefined>)[tool];
  if (!component) return null;
  // The image component's props are authored as a PATH; the daemon inlines
  // the bytes here, where the WireMsg is synthesized (the stdio stub has no
  // file access by design).
  if (component === "image") props = resolveImageProps(workspaceDir, props);
  // These props come from the engine's EVENT STREAM, not from the stub that
  // validated the tool call — a steered engine controls them directly. The
  // browser re-validates, but the server must not hand it a link scheme or
  // a bad shape it never checked (audit 2026-08-26). The tolerant twin
  // (unknown keys STRIPPED) is deliberate: it is what the stub and the
  // in-process SDK server both apply, so a call the engine was told
  // "Rendered" for is never dropped here over an extra key (cold review).
  const checked = clientSchemas[component].safeParse(props);
  if (!checked.success) return null;
  return { type: "render", component, props: checked.data as Record<string, unknown>, id };
}

/**
 * How to spawn the stdio render-MCP server (server/render-mcp.ts) for engines
 * that load MCP servers as subprocesses (Codex, Gemini CLI). Two homes:
 * - Packaged install: the esbuild bundle emits render-mcp.js BESIDE this
 *   code (dist-server/) — run it with the daemon's own node binary.
 * - Dev checkout: no compiled twin exists — run the TS source under the
 *   repo's tsx.
 */
export function renderMcpCommand(): { command: string; args: string[] } {
  const compiled = path.join(HERE, "render-mcp.js");
  if (existsSync(compiled)) return { command: process.execPath, args: [compiled] };
  return {
    command: path.resolve(HERE, "..", "..", "node_modules", ".bin", "tsx"),
    args: [path.resolve(HERE, "..", "render-mcp.ts")],
  };
}
