#!/usr/bin/env node
/**
 * Prove piwork-connectors end-to-end with a NO-AUTH MCP server (the "everything" demo):
 * install the connector globally → write a connectors config → start a session → confirm
 * the connector connects, lists tools, and registers them (via its "N tools ready" notify).
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContainerBridge } from "../electron/container.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SUITE = path.join(REPO, "packages");
const NODE_MODULES = path.join(REPO, "node_modules");
const IMAGE = process.env.PIWORK_IMAGE ?? "piwork-sandbox:spike";
const DOCKER = process.env.PIWORK_DOCKER || "docker";

const base = mkdtempSync(path.join(REPO, ".smoke-tmp-"));
const project = path.join(base, "project");
const agent = path.join(base, "agent");
const conn = path.join(base, "connectors");
mkdirSync(project, { recursive: true });
mkdirSync(agent, { recursive: true });
mkdirSync(conn, { recursive: true });
writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "ollama", defaultModel: "gemma4:12b" }));
writeFileSync(path.join(conn, "global.json"), JSON.stringify({
  servers: [{ id: "everything", label: "Everything", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"], enabled: true }],
}));

console.error("=== install piwork-connectors globally ===");
execFileSync(DOCKER, [
  "run", "--rm", "--entrypoint", "/opt/pi-host/node_modules/.bin/pi",
  "-v", `${agent}:/root/.pi/agent`, "-v", `${SUITE}:/opt/piwork-suite:ro`,
  IMAGE, "install", "/opt/piwork-suite/piwork-connectors",
], { stdio: "inherit" });

console.error("\n=== start session; connector should load the 'everything' server ===");
const b = new ContainerBridge();
const seen = { ready: false, count: 0, failed: null };
b.on("stderr", (c) => process.stderr.write(`[c] ${c}`));
b.on("error", (e) => console.error("bridge error", e.message));
b.on("ui_request", (r) => {
  if (r.method !== "notify") return;
  const m = String(r.message ?? "");
  console.error(`notify: ${m}`);
  const ok = m.match(/Connector "Everything": (\d+) tool/);
  if (ok) { seen.ready = true; seen.count = Number(ok[1]); }
  if (/Connector "Everything" failed/.test(m)) seen.failed = m;
});
b.on("event", () => {});
b.start({
  workspace: project,
  image: IMAGE,
  agentHostDir: agent,
  addHostGateway: true,
  env: { PIWORK_WS_KEY: "test" },
  extraDockerArgs: [
    "-v", `${SUITE}:/opt/piwork-suite:ro`,
    "-v", `${NODE_MODULES}:/opt/node_modules:ro`,
    "-v", `${conn}:/root/.piwork-connectors:ro`,
  ],
});

const started = Date.now();
const poll = setInterval(async () => {
  if (seen.ready || seen.failed || Date.now() - started > 90_000) {
    clearInterval(poll);
    await b.stop();
    try { rmSync(base, { recursive: true, force: true }); } catch {}
    console.error("\n=========== CONNECTOR SMOKE ===========");
    console.error(`connector connected + tools: ${seen.ready ? `YES (${seen.count})` : "no"}`);
    if (seen.failed) console.error(`failure: ${seen.failed}`);
    console.error(`\nRESULT: ${seen.ready && seen.count > 0 ? "PASS ✅" : "FAIL ❌"}`);
    console.error("=======================================");
    process.exit(seen.ready && seen.count > 0 ? 0 : 1);
  }
}, 500);
