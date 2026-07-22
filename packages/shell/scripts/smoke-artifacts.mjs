#!/usr/bin/env node
/**
 * Verify piwork-artifacts: a file in /workspace/.artifacts/ auto-shows via the artifact
 * intent on session start, and a file written AFTER start is picked up by the watcher.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContainerBridge } from "../electron/container.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SUITE = path.join(REPO, "packages");
const IMAGE = process.env.PIWORK_IMAGE ?? "piwork-sandbox:spike";
const DOCKER = process.env.PIWORK_DOCKER || "docker";

const base = mkdtempSync(path.join(REPO, ".smoke-tmp-"));
const project = path.join(base, "project");
const agent = path.join(base, "agent");
mkdirSync(path.join(project, ".artifacts"), { recursive: true });
mkdirSync(agent, { recursive: true });
writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "ollama", defaultModel: "gemma4:12b" }));
// A file present BEFORE the session starts (session_start scan should show it).
writeFileSync(path.join(project, ".artifacts", "report.md"), "# Report\n\nHello from an artifact file.");

console.error("=== install piwork-artifacts globally ===");
execFileSync(DOCKER, [
  "run", "--rm", "--entrypoint", "/opt/pi-host/node_modules/.bin/pi",
  "-v", `${agent}:/root/.pi/agent`, "-v", `${SUITE}:/opt/piwork-suite:ro`,
  IMAGE, "install", "/opt/piwork-suite/piwork-artifacts",
], { stdio: "inherit" });

const b = new ContainerBridge();
const seen = { onStart: false, afterWrite: false };
b.on("stderr", () => {});
b.on("error", (e) => console.error("bridge error", e.message));
b.on("ui_request", (r) => {
  if (r.method !== "artifact") return;
  console.error(`artifact intent: key=${r.key} md?=${r.markdown != null} html?=${r.html != null}`);
  if (r.key === "report.md") seen.onStart = true;
  if (r.key === "live.html") seen.afterWrite = true;
});
b.on("event", () => {});
b.start({
  workspace: project, image: IMAGE, agentHostDir: agent, addHostGateway: true,
  extraDockerArgs: ["-v", `${SUITE}:/opt/piwork-suite:ro`],
});

// After the session is up, write a NEW file — the poller should pick it up.
setTimeout(() => writeFileSync(path.join(project, ".artifacts", "live.html"), "<h1>Live</h1>"), 4000);

setTimeout(async () => {
  await b.stop();
  try { rmSync(base, { recursive: true, force: true }); } catch {}
  console.error("\n=========== ARTIFACTS SMOKE ===========");
  console.error(`existing file shown on start : ${seen.onStart ? "YES" : "no"}`);
  console.error(`new file picked up (watcher)  : ${seen.afterWrite ? "YES" : "no"}`);
  const pass = seen.onStart && seen.afterWrite;
  console.error(`\nRESULT: ${pass ? "PASS ✅" : "FAIL ❌"}`);
  console.error("=======================================");
  process.exit(pass ? 0 : 1);
}, 12000);
