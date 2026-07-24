#!/usr/bin/env node
/** Phase 2: the global console can configure Piwork itself.
 *  A) a pre-placed global skill auto-loads (resources mode sees it — "loads everywhere").
 *  B) a live global session's piwork_write_config tool writes into the config store (scoped,
 *     persisted to host) — with noTools:builtin, so no raw file/bash tool exists. */
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
const cfg = path.join(base, "config");
mkdirSync(ws, { recursive: true });
mkdirSync(agent, { recursive: true });
mkdirSync(path.join(cfg, "skills", "piwork-smoke-skill"), { recursive: true });
mkdirSync(path.join(cfg, "extensions"), { recursive: true });
writeFileSync(path.join(cfg, "skills", "piwork-smoke-skill", "SKILL.md"),
  "---\nname: piwork-smoke-skill\ndescription: a pre-placed global skill for the smoke test\n---\n# hi\n");
writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { ollama: { baseUrl: "http://host.docker.internal:11434/v1", api: "openai-completions", apiKey: "ollama", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: "gemma4:12b" }] } } }));
writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "ollama", defaultModel: "gemma4:12b" }));
writeFileSync(path.join(agent, "auth.json"), JSON.stringify({ ollama: { type: "api_key", key: "ollama" } }));

const res = { skillLoaded: false, writeToolCalled: false, hostFileWritten: false };

// ── Part A: resources mode sees the global skill ───────────────────────────────────
function partA() {
  return new Promise((resolve) => {
    const args = ["run", "--rm", "-e", "PIWORK_MODE=resources", "-e", "PIWORK_CONFIG_DIR=/root/.piwork-config",
      "-v", `${ws}:/workspace`, "-v", `${agent}:/root/.pi/agent`, "-v", `${cfg}:/root/.piwork-config:ro`, IMAGE];
    const p = spawn(DOCKER, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (c) => (out += c));
    p.on("error", () => resolve());
    p.on("exit", () => {
      const line = out.split("\n").find((l) => l.includes("piwork_resources"));
      try {
        const skills = JSON.parse(line ?? "").skills ?? [];
        res.skillLoaded = skills.some((s) => s.name === "piwork-smoke-skill");
      } catch { /* leave false */ }
      resolve();
    });
  });
}

// ── Part B: live global session's write tool writes into the config store ───────────
function partB() {
  return new Promise((resolve) => {
    const b = new ContainerBridge();
    const written = path.join(cfg, "skills", "agent-written", "SKILL.md");
    b.on("stderr", () => {});
    b.on("error", () => {});
    b.on("event", (e) => {
      if (e.type === "tool_execution_start" && e.toolName === "piwork_write_config") res.writeToolCalled = true;
    });
    b.on("hello", () => {
      b.prompt('Call the piwork_write_config tool now. Pass exactly these arguments: path = "skills/agent-written/SKILL.md", content = "---\\nname: agent-written\\ndescription: written by the smoke test\\n---\\n# written". Do not ask for confirmation.', { id: "p1" });
    });
    b.start({
      workspace: ws, image: IMAGE, agentHostDir: agent, addHostGateway: true,
      extraDockerArgs: ["-v", `${cfg}:/root/.piwork-config`],
      env: { PIWORK_NO_TOOLS: "builtin", PIWORK_CONFIG_DIR: "/root/.piwork-config", PIWORK_CONFIG_WRITABLE: "1", PIWORK_SESSION_DIR: "/root/.pi/agent/sessions/global" },
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
console.error(`write tool invoked by agent           : ${res.writeToolCalled ? "YES" : "no"}`);
console.error(`config file persisted to host store   : ${res.hostFileWritten ? "YES" : "no"}`);
const pass = res.skillLoaded && res.hostFileWritten;
console.error(`\nRESULT: ${pass ? "PASS ✅" : "FAIL ❌"}`);
console.error("=====================================================");
process.exit(pass ? 0 : 1);
