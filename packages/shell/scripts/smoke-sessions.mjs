#!/usr/bin/env node
/**
 * Verify the session lifecycle used by the launcher: create a persisted session →
 * list it (pi-host "list" mode) → resume it (open by path) and confirm history is back.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContainerBridge } from "../electron/container.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const IMAGE = process.env.PIWORK_IMAGE ?? "piwork-sandbox:spike";
const DOCKER = process.env.PIWORK_DOCKER || "docker";
const SESSION_DIR = "/root/.pi/agent/sessions/ws-test";

function makeWs() {
  const base = mkdtempSync(path.join(REPO, ".smoke-tmp-"));
  const project = path.join(base, "project");
  const agent = path.join(base, "agent");
  mkdirSync(project, { recursive: true });
  mkdirSync(agent, { recursive: true });
  writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { ollama: { baseUrl: "http://host.docker.internal:11434/v1", api: "openai-completions", apiKey: "ollama", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: "gemma4:12b" }] } } }));
  writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "ollama", defaultModel: "gemma4:12b" }));
  writeFileSync(path.join(agent, "auth.json"), JSON.stringify({ ollama: { type: "api_key", key: "ollama" } }));
  return { base, project, agent };
}

const common = (ws, env) => ({ workspace: ws.project, image: IMAGE, agentHostDir: ws.agent, addHostGateway: true, env });

function runSession(ws, env, drive) {
  return new Promise((resolve) => {
    const b = new ContainerBridge();
    const state = { messages: [] };
    b.on("stderr", () => {});
    b.on("hello", () => drive(b, state));
    b.on("event", (e) => { if (e.type === "agent_end") state.agentEnded = true; });
    b.on("response", (r) => { if (r.command === "get_messages" && r.success) state.messages = r.data?.messages ?? []; });
    b.start(common(ws, env));
    setTimeout(async () => { await b.stop(); resolve(state); }, 20000);
  });
}

function listSessions(ws) {
  return new Promise((resolve, reject) => {
    const p = spawn(DOCKER, [
      "run", "--rm", "-e", "PIWORK_MODE=list", "-e", `PIWORK_SESSION_DIR=${SESSION_DIR}`,
      "--add-host=host.docker.internal:host-gateway",
      "-v", `${ws.project}:/workspace`, "-v", `${ws.agent}:/root/.pi/agent`,
      IMAGE,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (c) => (out += c));
    p.on("exit", () => {
      const line = out.split("\n").find((l) => l.includes("piwork_sessions"));
      try { resolve(JSON.parse(line).sessions); } catch (e) { reject(new Error("no session list: " + out.slice(0, 200))); }
    });
  });
}

const ws = makeWs();
const MARKER = "REMEMBER_APPLE_42";
console.error("=== 1. create a session (persisted) ===");
await runSession(ws, { PIWORK_SESSION_DIR: SESSION_DIR }, (b) => b.prompt(`Reply "ok". The secret is ${MARKER}.`, { id: "p1" }));

console.error("\n=== 2. list sessions ===");
const sessions = await listSessions(ws);
console.error(`found ${sessions.length} session(s):`, sessions.map((s) => `${s.id} "${(s.firstMessage || "").slice(0, 40)}" msgs=${s.messageCount}`));

let resumed = { messages: [] };
if (sessions[0]) {
  console.error("\n=== 3. resume that session by path, read history ===");
  resumed = await runSession(ws, { PIWORK_SESSION_DIR: SESSION_DIR, PIWORK_SESSION: sessions[0].path }, (b) => b.send({ id: "gm", type: "get_messages" }));
}
const historyHasMarker = JSON.stringify(resumed.messages).includes(MARKER);

try { rmSync(ws.base, { recursive: true, force: true }); } catch {}
console.error("\n=========== SESSION LIFECYCLE ===========");
console.error(`listed >=1 session : ${sessions.length >= 1 ? "YES" : "no"}`);
console.error(`firstMessage shown : ${sessions[0]?.firstMessage ? "YES" : "no"}`);
console.error(`resume restored history: ${historyHasMarker ? "YES" : "no"}`);
const pass = sessions.length >= 1 && !!sessions[0]?.firstMessage && historyHasMarker;
console.error(`\nRESULT: ${pass ? "PASS ✅" : "FAIL ❌"}`);
console.error("=========================================");
process.exit(pass ? 0 : 1);
