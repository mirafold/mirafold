#!/usr/bin/env node
// Distill Codex's app-server protocol (what `codex app-server
// generate-json-schema` prints, ~4 MB) into the few facts the adapter
// depends on: the thread-item kinds, the server notification and request
// methods, and the shapes of the fields the adapter reads. The digest is
// vendored at server/adapters/codex-protocol.digest.json so Tier 1 can hold
// the adapter to it offline; the Tier-4 live test regenerates it from the
// installed Codex and fails on drift. Usage:
//   node scripts/codex-protocol-digest.mjs            # print JSON
//   node scripts/codex-protocol-digest.mjs --write    # update the vendored file
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function generateDigest(codexBin = process.env.MIRAFOLD_CODEX_BIN ?? "codex") {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-schema-"));
  try {
    execFileSync(codexBin, ["app-server", "generate-json-schema", "--out", dir], { stdio: "ignore", timeout: 60_000 });
    const doc = JSON.parse(readFileSync(path.join(dir, "codex_app_server_protocol.v2.schemas.json"), "utf8"));
    return digestFrom(doc);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function tagOf(variant) {
  const props = variant.properties ?? {};
  for (const key of ["type", "method"]) {
    const p = props[key];
    if (p?.const) return p.const;
    if (Array.isArray(p?.enum) && p.enum.length === 1) return p.enum[0];
  }
  return undefined;
}

const variants = (def) => [...(def?.oneOf ?? []), ...(def?.anyOf ?? [])];

function describeType(schema, defs, depth = 0) {
  if (!schema || depth > 3) return "?";
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop();
    const target = defs[name];
    if (variants(target).length) return `oneOf(${variants(target).map((v) => tagOf(v) ?? describeType(v, defs, depth + 1)).join("|")})`;
    return `${name}:${describeType(target, defs, depth + 1)}`;
  }
  if (Array.isArray(schema.type)) return schema.type.join("|");
  if (schema.type === "array") return `array<${describeType(schema.items, defs, depth + 1)}>`;
  if (schema.type === "object") return `object{${Object.keys(schema.properties ?? {}).sort().join(",")}}`;
  if (schema.enum) return `enum(${schema.enum.join("|")})`;
  if (variants(schema).length) return `oneOf(${variants(schema).map((v) => tagOf(v) ?? describeType(v, defs, depth + 1)).join("|")})`;
  return schema.type ?? "?";
}

export function digestFrom(doc) {
  const defs = doc.definitions ?? doc.$defs ?? {};
  const items = {};
  for (const v of variants(defs.ThreadItem)) {
    const tag = tagOf(v);
    if (tag) items[tag] = Object.keys(v.properties ?? {}).filter((k) => k !== "type").sort();
  }
  const notifications = variants(defs.ServerNotification).map(tagOf).filter(Boolean).sort();
  const requests = variants(defs.ServerRequest).map(tagOf).filter(Boolean).sort();
  // The field shapes the adapter reads. Each entry is "definition.property"
  // → a compact type string; a change here is exactly the bug class that
  // hid a month of diffs.
  const fields = {};
  const want = [
    ["FileUpdateChange", "kind"],
    ["FileUpdateChange", "diff"],
    ["FileUpdateChange", "path"],
    ["PatchChangeKind", null],
    ["CommandExecutionOutputDeltaNotification", "delta"],
    ["FileChangePatchUpdatedNotification", "changes"],
    ["TurnDiffUpdatedNotification", "diff"],
  ];
  for (const [def, prop] of want) {
    const d = defs[def];
    if (!d) { fields[`${def}${prop ? "." + prop : ""}`] = "MISSING"; continue; }
    fields[`${def}${prop ? "." + prop : ""}`] = prop ? describeType(d.properties?.[prop], defs) : describeType(d, defs);
  }
  for (const tag of ["fileChange", "commandExecution", "agentMessage", "mcpToolCall"]) {
    const v = variants(defs.ThreadItem).find((x) => tagOf(x) === tag);
    if (!v) continue;
    for (const [k, schema] of Object.entries(v.properties ?? {})) {
      if (k === "type") continue;
      fields[`ThreadItem.${tag}.${k}`] = describeType(schema, defs);
    }
  }
  return { items, notifications, requests, fields };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const digest = generateDigest();
  const json = JSON.stringify(digest, null, 2) + "\n";
  if (process.argv.includes("--write")) {
    const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "adapters", "codex-protocol.digest.json");
    writeFileSync(out, json);
    console.log(`wrote ${out}: ${Object.keys(digest.items).length} item kinds, ${digest.notifications.length} notifications, ${digest.requests.length} requests`);
  } else {
    process.stdout.write(json);
  }
}
