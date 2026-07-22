#!/usr/bin/env node
/**
 * Delivery smoke test: prove a Suite extension installed into the agent volume via
 * `pi install` loads into a session — WITHOUT corrupting the JSONL protocol.
 *
 * Steps: build a temp agent dir (ollama config) → `pi install` piwork-checkpoint into
 * it (local path, mounted) → start a session with the suite mounted → assert the
 * extension's session_start notify fires AND `/checkpoint` shows in get_commands.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContainerBridge } from "../electron/container.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const SUITE = path.join(REPO, "packages"); // mounted at /opt/piwork-suite
const IMAGE = process.env.PIWORK_IMAGE ?? "piwork-sandbox:spike";
const DOCKER = process.env.PIWORK_DOCKER || "docker";

function makeAgentDir() {
  const base = mkdtempSync(path.join(REPO, ".smoke-tmp-"));
  const agent = path.join(base, "agent");
  mkdirSync(agent, { recursive: true });
  writeFileSync(path.join(agent, "models.json"), JSON.stringify({
    providers: { ollama: { baseUrl: "http://host.docker.internal:11434/v1", api: "openai-completions", apiKey: "ollama", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: "gemma4:12b" }] } },
  }));
  writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "ollama", defaultModel: "gemma4:12b" }));
  writeFileSync(path.join(agent, "auth.json"), JSON.stringify({ ollama: { type: "api_key", key: "ollama" } }));
  return { base, agent };
}

const ws = makeAgentDir();
console.error("=== pi install piwork-checkpoint into the volume ===");
execFileSync(DOCKER, [
  "run", "--rm", "--entrypoint", "/opt/pi-host/node_modules/.bin/pi",
  "-v", `${ws.agent}:/root/.pi/agent`,
  "-v", `${SUITE}:/opt/piwork-suite:ro`,
  IMAGE, "install", "/opt/piwork-suite/piwork-checkpoint",
], { stdio: "inherit" });

console.error("\n=== start a session with the suite mounted ===");
const b = new ContainerBridge();
const seen = { hello: false, checkpointNotify: false, hasCommand: false, openExternal: false, artifact: false };

b.on("stderr", (c) => process.stderr.write(`[c] ${c}`));
b.on("hello", (h) => { seen.hello = true; console.error(`hello pi=${h.piVersion}`); b.send({ id: "gc", type: "get_commands" }); });
b.on("ui_request", (r) => {
  if (r.method === "artifact") { seen.artifact = true; console.error(`artifact intent: key=${r.key} title=${JSON.stringify(r.title)} htmlLen=${(r.html ?? "").length}`); return; }
  if (r.method === "openExternal") { seen.openExternal = true; console.error(`first-class openExternal intent: url=${r.url}`); return; }
  if (r.method !== "notify") return;
  const msg = String(r.message ?? "");
  if (msg.includes("piwork-checkpoint")) { seen.checkpointNotify = true; console.error(`notify: ${msg}`); }
  if (msg.includes("__piworkIntent__") && msg.includes("openExternal")) { seen.openExternal = true; console.error(`openExternal (fallback): ${msg}`); }
});
b.on("response", (r) => {
  if (r.command === "get_commands" && r.success) {
    const names = (r.data?.commands ?? []).map((c) => c.name);
    seen.hasCommand = names.includes("checkpoint");
    console.error(`commands: ${names.join(", ")}`);
    if (names.includes("piwork-help")) b.prompt("/piwork-help", { id: "help" }); // exercise openExternal
    if (names.includes("artifact-demo")) b.prompt("/artifact-demo", { id: "art" }); // exercise artifact intent
  }
});
b.on("event", () => {});
b.on("error", (e) => console.error("bridge error", e.message));

b.start({
  workspace: ws.agent, // any dir; not the point here
  image: IMAGE,
  agentHostDir: ws.agent,
  addHostGateway: true,
  extraDockerArgs: ["-v", `${SUITE}:/opt/piwork-suite:ro`],
});

setTimeout(async () => {
  await b.stop();
  try { rmSync(ws.base, { recursive: true, force: true }); } catch {}
  console.error("\n=========== SUITE DELIVERY SMOKE ===========");
  console.error(`handshake              : ${seen.hello ? "YES" : "no"}`);
  console.error(`extension loaded notify: ${seen.checkpointNotify ? "YES" : "no"}`);
  console.error(`/checkpoint registered : ${seen.hasCommand ? "YES" : "no"}`);
  console.error(`openExternal path      : ${seen.openExternal ? "YES" : "no"}`);
  console.error(`artifact intent        : ${seen.artifact ? "YES" : "no"}`);
  const pass = seen.hello && seen.checkpointNotify && seen.hasCommand && seen.openExternal && seen.artifact;
  console.error(`\nRESULT: ${pass ? "PASS ✅" : "FAIL ❌"}`);
  console.error("============================================");
  process.exit(pass ? 0 : 1);
}, 12000);
