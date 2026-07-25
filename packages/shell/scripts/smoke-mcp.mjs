#!/usr/bin/env node
/** Connectors v2 (pi-mcp-adapter) wiring smoke — no real OAuth (needs a browser+provider):
 *  - the baked adapter loads and registers the `mcp` proxy tool
 *  - Piwork relay commands are present (piwork-mcp-auth/complete/logout/status)
 *  - a global mcp.json with an OAuth server is discovered; /piwork-mcp-status emits an
 *    mcpStatus intent reporting that server as oauth + not_authenticated. */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContainerBridge } from "../electron/container.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const IMAGE = process.env.PIWORK_IMAGE ?? "piwork-sandbox:spike";

const base = mkdtempSync(path.join(REPO, ".smoke-tmp-"));
const ws = path.join(base, "cwd");
const agent = path.join(base, "agent");
const mcpGlobal = path.join(base, "mcp-global");
mkdirSync(ws, { recursive: true });
mkdirSync(agent, { recursive: true });
mkdirSync(mcpGlobal, { recursive: true });
// Global mcp.json (mounted at /root/.config/mcp) with a hosted OAuth connector.
writeFileSync(path.join(mcpGlobal, "mcp.json"), JSON.stringify({
  mcpServers: { notion: { label: "Notion", url: "https://mcp.notion.com/mcp", auth: "oauth", oauth: { redirectUri: "http://localhost:51823/callback" } } },
}));
writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { ollama: { baseUrl: "http://host.docker.internal:11434/v1", api: "openai-completions", apiKey: "ollama", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: "gemma4:12b" }] } } }));
writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "ollama", defaultModel: "gemma4:12b" }));
writeFileSync(path.join(agent, "auth.json"), JSON.stringify({ ollama: { type: "api_key", key: "ollama" } }));

const b = new ContainerBridge();
const seen = { cmds: [], mcpTool: false, status: null };
b.on("stderr", () => {});
b.on("error", () => {});
b.on("hello", () => b.send({ id: "gc", type: "get_commands" }));
let done = () => {};
b.on("response", (r) => {
  if (r.command === "get_commands" && r.success) {
    seen.cmds = (r.data?.commands ?? []).map((c) => c.name);
    seen.mcpTool = seen.cmds.includes("mcp");
    b.send({ type: "prompt", message: "/piwork-mcp-status" });
  }
});
b.on("ui_request", (r) => {
  if (r.method === "mcpStatus") { seen.status = r.servers; setTimeout(() => b.stop().then(() => done()), 300); }
});
b.start({
  workspace: ws, image: IMAGE, agentHostDir: agent, addHostGateway: true,
  extraDockerArgs: ["-v", `${mcpGlobal}:/root/.config/mcp`],
});
await new Promise((res) => { done = res; setTimeout(res, 40000); });
try { rmSync(base, { recursive: true, force: true }); } catch {}

const relay = ["piwork-mcp-auth", "piwork-mcp-complete", "piwork-mcp-logout", "piwork-mcp-status"];
const relayOk = relay.every((c) => seen.cmds.includes(c));
const notion = Array.isArray(seen.status) ? seen.status.find((s) => s.name === "notion") : undefined;
console.error("\n=========== CONNECTORS v2 (pi-mcp-adapter) SMOKE ===========");
console.error(`adapter proxy tool present       : ${seen.mcpTool ? "YES" : "no"}`);
console.error(`relay commands present           : ${relayOk ? "YES" : "no (" + relay.filter((c) => !seen.cmds.includes(c)).join(",") + ")"}`);
console.error(`mcpStatus intent received        : ${seen.status ? "YES" : "no"}`);
console.error(`notion reported oauth+unauthed    : ${notion && notion.oauth && notion.status === "not_authenticated" ? "YES" : "no (" + JSON.stringify(notion) + ")"}`);
const pass = seen.mcpTool && relayOk && notion && notion.oauth && notion.status === "not_authenticated";
console.error(`\nRESULT: ${pass ? "PASS ✅" : "FAIL ❌"}`);
console.error("===========================================================");
process.exit(pass ? 0 : 1);
