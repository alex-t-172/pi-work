#!/usr/bin/env node
/** Project-level "create your own extension" loop, end to end:
 *  a normal folder session (full file tools) writes a .pi/ extension with its file tool,
 *  /piwork-reload loads it live, and the new slash command appears in get_commands.
 *  (Global authoring uses custom tools because it has no file access; project authoring
 *  just uses the ordinary file tools + the baked writing-piwork-extensions skill.) */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContainerBridge } from "../electron/container.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const IMAGE = process.env.PIWORK_IMAGE ?? "piwork-sandbox:spike";

const base = mkdtempSync(path.join(REPO, ".smoke-tmp-"));
const project = path.join(base, "project");
const agent = path.join(base, "agent");
mkdirSync(project, { recursive: true });
mkdirSync(agent, { recursive: true });
writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { ollama: { baseUrl: "http://host.docker.internal:11434/v1", api: "openai-completions", apiKey: "ollama", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: "gemma4:12b" }] } } }));
writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "ollama", defaultModel: "gemma4:12b" }));
writeFileSync(path.join(agent, "auth.json"), JSON.stringify({ ollama: { type: "api_key", key: "ollama" } }));

// A minimal, import-free extension so gemma can reproduce it verbatim and it loads cleanly.
// Flat form (.pi/extensions/<name>.ts) — the layout the writing-piwork-extensions skill teaches.
const EXT = 'export default function (pi) {\n  pi.registerCommand("smoke-hello", { description: "smoke test command", handler: async () => {} });\n}\n';
const EXT_PATH = path.join(project, ".pi", "extensions", "smoke-ext.ts");

const res = { wroteFile: false, commandLive: false };
const b = new ContainerBridge();
b.on("stderr", () => {});
b.on("error", () => {});
b.on("event", (e) => {
  if (e.type === "tool_execution_start") console.error(`tool: ${e.toolName}`);
});
b.on("hello", () => {
  b.prompt(
    `Create a Piwork extension for this project. Use your file-writing tool to create the file ${".pi/extensions/smoke-ext.ts"} with EXACTLY this content and nothing else:\n\n${EXT}\nDo not ask for confirmation; just write the file.`,
    { id: "p1" }
  );
});
let asked = false;
b.on("response", (r) => {
  if (r.command === "get_commands" && r.success) {
    const names = (r.data?.commands ?? []).map((c) => c.name);
    if (asked) res.commandLive = names.includes("smoke-hello");
  }
});

b.start({ workspace: project, image: IMAGE, agentHostDir: agent, addHostGateway: true });

// Stage 1 (t=45s): did the agent write the file? then reload.
setTimeout(() => {
  res.wroteFile = existsSync(EXT_PATH);
  if (res.wroteFile) b.send({ type: "prompt", message: "/piwork-reload" });
}, 45000);
// Stage 2 (t=55s): ask for the command list after reload.
setTimeout(() => { asked = true; b.send({ id: "gc2", type: "get_commands" }); }, 55000);
// Stage 3 (t=62s): report.
setTimeout(async () => {
  await b.stop();
  try { rmSync(base, { recursive: true, force: true }); } catch {}
  console.error("\n======= PROJECT AUTHORING (E2E) SMOKE =======");
  console.error(`agent wrote .pi/ extension via file tool : ${res.wroteFile ? "YES" : "no"}`);
  console.error(`/smoke-hello live after reload           : ${res.commandLive ? "YES" : "no"}`);
  const pass = res.wroteFile && res.commandLive;
  console.error(`\nRESULT: ${pass ? "PASS ✅" : "FAIL ❌"}`);
  console.error("=============================================");
  process.exit(pass ? 0 : 1);
}, 62000);
