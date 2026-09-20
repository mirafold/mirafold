import type { SessionMsg } from "../../protocol";
import { CodexEventMapper } from "../../adapters/codex/codex-events";
import { GeminiCliSession } from "../../adapters/gemini-cli/gemini-cli";

/** Native provider records, normalized by the actual adapters before storage
 *  and browser replay. No model or provider process runs in this fixture. */
export function componentUsageMessages(): SessionMsg[] {
  const messages: SessionMsg[] = [{ type: "user_prompt", text: "Inspect these native edits." }];
  const mapper = new CodexEventMapper({ emit: (m) => messages.push(m), workspaceDir: "/tmp/cu-workspace", modelName: () => "fixture", providerDiagnostic: String });
  mapper.beginTurn();
  const patch = { id: "native-patch", type: "fileChange", status: "completed", changes: [
    { path: "/tmp/cu-workspace/src/" + "long-path-".repeat(15) + "retry.ts", kind: { type: "update" }, diff: "@@ -1,40 +1,40 @@\n" + " context\n".repeat(20) + "-const retries = 2;\n+const retries = 4;\n" + " context\n".repeat(20) },
    { path: "/tmp/cu-workspace/new.txt", kind: { type: "add" }, diff: "new content\n" },
    { path: "/tmp/cu-workspace/gone.txt", kind: { type: "delete" }, diff: "removed content" },
    { path: "/tmp/cu-workspace/old.txt", kind: { type: "update", move_path: "/tmp/cu-workspace/moved.txt" }, diff: "" },
  ] };
  mapper.handle("item/started", { item: { ...patch, status: "inProgress" } });
  mapper.handle("item/completed", { item: patch });
  const gemini = new GeminiCliSession({ workspaceDir: "/tmp/cu-workspace" });
  gemini.onMessage((m) => messages.push(m));
  const handle = (event: Record<string, unknown>) => (gemini as unknown as { handleEvent: (event: Record<string, unknown>) => void }).handleEvent(event);
  for (const [id, name, parameters, status] of [
    ["gemini-edit", "replace", { file_path: "gemini.ts", old_string: "before\n", new_string: "after\n" }, "success"],
    ["gemini-write", "write_file", { file_path: "written.ts", content: "\nwritten content\n\nlast line\n\n" }, "success"],
    ["gemini-multi", "replace", { file_path: "multiple.ts", old_string: "before\n", new_string: "after\n", allow_multiple: true }, "success"],
    ["gemini-failed", "replace", { file_path: "failed.ts", old_string: "never\n", new_string: "applied\n" }, "error"],
  ] as const) {
    handle({ type: "tool_use", tool_id: id, tool_name: name, parameters });
    handle({ type: "tool_result", tool_id: id, status, output: status === "error" ? "replacement not found" : "done" });
  }
  gemini.close();
  // Persisted records from the earlier adapter bypass normalization on replay.
  for (const [id, extra] of [["retained-multiple", { allow_multiple: true }], ["retained-count", { expected_replacements: 2 }]] as const) {
    messages.push(
      { type: "tool_use", id, name: "Edit", detail: `${id}.ts · replace`, input: { file_path: `${id}.ts`, old_string: "before\n", new_string: "after\n", ...extra } },
      { type: "tool_result", id, output: "done", isError: false },
    );
  }
  messages.push(
    { type: "tool_use", id: "child", name: "Agent", detail: "child edit" },
    { type: "tool_use", id: "child-edit", name: "Edit", parentId: "child", input: { file_path: "child.ts", old_string: "child old\n", new_string: "child new\n" } },
    { type: "tool_result", id: "child-edit", parentId: "child", output: "done", isError: false },
    { type: "tool_result", id: "child", output: "child completed", isError: false },
    { type: "tool_use", id: "pending", name: "Edit", input: { file_path: "pending.ts", old_string: "pending old", new_string: "pending new" } },
  );
  return messages.map((m, i) => ({ ...m, seq: i + 1 }));
}
