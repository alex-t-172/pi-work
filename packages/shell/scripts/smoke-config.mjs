#!/usr/bin/env node
/** Phase 2: the global console configures Piwork itself, writing GLOBAL skills/extensions
 *  into the agent store's native scan locations (~/.pi/agent/{skills,extensions}) so they
 *  load in every session.
 *  A) a pre-placed global skill + extension auto-load (resources sees the skill; a live
 *     session sees the extension's command) — "loads everywhere", no extra wiring.
 *  B) a live global session's piwork_write_config tool authors an EXTENSION into the store
 *     (scoped, persisted, then live after /piwork-reload) — with noTools:builtin, so no raw
 *     file/bash tool exists and auth.json (a sibling of skills/extensions) is unreachable. */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContainerBridge } from "../electron/container.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const IMAGE = process.env.PIWORK_IMAGE ?? "piwork-sandbox:spike";
const DOCKER = process.env.PIWORK_DOCKER ?? path.join(process.env.HOME, ".rd", "bin", "docker");

const base = mkdtempSync(path.join(REPO, ".smoke-tmp-"));
const ws = path.join(base, "cwd");
const agent = path.join(base, "agent");
mkdirSync(ws, { recursive: true });
mkdirSync(path.join(agent, "skills", "piwork-smoke-skill"), { recursive: true });
mkdirSync(path.join(agent, "extensions", "piwork-smoke-ext"), { recursive: true });
writeFileSync(path.join(agent, "skills", "piwork-smoke-skill", "SKILL.md"),
  "---\nname: piwork-smoke-skill\ndescription: a pre-placed global skill for the smoke test\n---\n# hi\n");
writeFileSync(path.join(agent, "extensions", "piwork-smoke-ext", "index.ts"),
  'export default function (pi) { pi.registerCommand("smoke-preplaced", { description: "x", handler: async () => {} }); }\n');
writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { ollama: { baseUrl: "http://host.docker.internal:11434/v1", api: "openai-completions", apiKey: "ollama", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: "gemma4:12b" }] } } }));
writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "ollama", defaultModel: "gemma4:12b" }));
writeFileSync(path.join(agent, "auth.json"), JSON.stringify({ ollama: { type: "api_key", key: "ollama" } }));

const res = { skillLoaded: false, extLoaded: false, writeToolCalled: false, hostFileWritten: false };
const agentVol = ["-v", `${agent}:/root/.pi/agent`];

// ── Part A: resources mode sees the global skill; a live session sees the extension ─────
function partA() {
  return new Promise((resolve) => {
    // A1: resources mode → skill present.
    const p = spawn(DOCKER, ["run", "--rm", "-e", "PIWORK_MODE=resources", "-v", `${ws}:/workspace`, ...agentVol, IMAGE], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (c) => (out += c));
    p.on("error", () => resolve());
    p.on("exit", () => {
      try { res.skillLoaded = (JSON.parse(out.split("\n").find((l) => l.includes("piwork_resources")) ?? "").skills ?? []).some((s) => s.name === "piwork-smoke-skill"); } catch { /* */ }
      // A2: live session → pre-placed extension command present.
      const b = new ContainerBridge();
      b.on("stderr", () => {}); b.on("error", () => {});
      b.on("hello", () => b.send({ id: "gc", type: "get_commands" }));
      b.on("response", (r) => {
        if (r.command === "get_commands") {
          res.extLoaded = (r.data?.commands ?? []).some((c) => c.name === "smoke-preplaced");
          b.stop().then(resolve);
        }
      });
      b.start({ workspace: ws, image: IMAGE, agentHostDir: agent, addHostGateway: true });
    });
  });
}

// ── Part B: live global console authors an extension via the write tool ─────────────────
function partB() {
  return new Promise((resolve) => {
    const b = new ContainerBridge();
    const written = path.join(agent, "extensions", "agent-ext", "index.ts");
    b.on("stderr", () => {});
    b.on("error", () => {});
    b.on("event", (e) => { if (e.type === "tool_execution_start" && e.toolName === "piwork_write_config") res.writeToolCalled = true; });
    b.on("hello", () => {
      b.prompt('Call the piwork_write_config tool now. Pass exactly: path = "extensions/agent-ext/index.ts", content = "export default function (pi) { pi.registerCommand(\\"agent-hello\\", { description: \\"hi\\", handler: async () => {} }); }". Do not ask for confirmation.', { id: "p1" });
    });
    b.start({
      workspace: ws, image: IMAGE, agentHostDir: agent, addHostGateway: true,
      env: { PIWORK_NO_TOOLS: "builtin", PIWORK_CONFIG_WRITABLE: "1", PIWORK_SESSION_DIR: "/root/.pi/agent/sessions/global" },
    });
    setTimeout(async () => {
      res.hostFileWritten = existsSync(written);
      await b.stop();
      resolve();
    }, 75000);
  });
}

await partA();
await partB();
try { rmSync(base, { recursive: true, force: true }); } catch {}

console.error("\n=========== PIWORK CONFIG (Phase 2) SMOKE ===========");
console.error(`global skill auto-loads (resources)   : ${res.skillLoaded ? "YES" : "no"}`);
console.error(`global extension auto-loads (session)  : ${res.extLoaded ? "YES" : "no"}`);
console.error(`write tool invoked by agent            : ${res.writeToolCalled ? "YES" : "no"}`);
console.error(`extension persisted to agent store     : ${res.hostFileWritten ? "YES" : "no"}`);
const pass = res.skillLoaded && res.extLoaded && res.hostFileWritten;
console.error(`\nRESULT: ${pass ? "PASS ✅" : "FAIL ❌"}`);
console.error("=====================================================");
process.exit(pass ? 0 : 1);
