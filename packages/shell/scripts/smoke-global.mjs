#!/usr/bin/env node
/** Verify a folderless, tool-restricted (noTools:builtin) global chat session starts and replies. */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContainerBridge } from "../electron/container.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const IMAGE = process.env.PIWORK_IMAGE ?? "piwork-sandbox:spike";

const base = mkdtempSync(path.join(REPO, ".smoke-tmp-"));
const ws = path.join(base, "cwd");
const agent = path.join(base, "agent");
mkdirSync(ws, { recursive: true });
mkdirSync(agent, { recursive: true });
writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { ollama: { baseUrl: "http://host.docker.internal:11434/v1", api: "openai-completions", apiKey: "ollama", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: "gemma4:12b" }] } } }));
writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "ollama", defaultModel: "gemma4:12b" }));
writeFileSync(path.join(agent, "auth.json"), JSON.stringify({ ollama: { type: "api_key", key: "ollama" } }));

const b = new ContainerBridge();
const seen = { hello: false, text: "", toolStarts: [] };
b.on("stderr", () => {});
b.on("error", (e) => console.error("bridge error", e.message));
b.on("hello", () => { seen.hello = true; b.prompt('Reply with exactly "GLOBAL_OK".', { id: "p1" }); });
b.on("event", (e) => {
  if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") seen.text += e.assistantMessageEvent.delta;
  if (e.type === "tool_execution_start") seen.toolStarts.push(e.toolName);
});
b.start({
  workspace: ws, image: IMAGE, agentHostDir: agent, addHostGateway: true,
  env: { PIWORK_NO_TOOLS: "builtin", PIWORK_SESSION_DIR: "/root/.pi/agent/sessions/global" },
});

setTimeout(async () => {
  await b.stop();
  try { rmSync(base, { recursive: true, force: true }); } catch {}
  console.error("\n=========== GLOBAL CHAT SMOKE ===========");
  console.error(`session started (hello) : ${seen.hello ? "YES" : "no"}`);
  console.error(`chat replied            : ${seen.text.includes("GLOBAL_OK") ? "YES" : "no (" + JSON.stringify(seen.text.slice(0,40)) + ")"}`);
  console.error(`tool calls (expect none): ${seen.toolStarts.length ? seen.toolStarts.join(",") : "none"}`);
  const pass = seen.hello && seen.text.includes("GLOBAL_OK");
  console.error(`\nRESULT: ${pass ? "PASS ✅" : "FAIL ❌"}`);
  console.error("=========================================");
  process.exit(pass ? 0 : 1);
}, 60000);
