#!/usr/bin/env node
/**
 * Headless smoke test for the shell's ContainerBridge (no Electron/display needed).
 *
 * Exercises the exact Node-side path the Electron main process uses: start the
 * container, receive the handshake, stream a prompt, and round-trip a blocking
 * ctx.ui.select — proving the shell's bridge layer works before wiring the GUI.
 *
 * Requires: the piwork-sandbox image built, Docker up, host Ollama running.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContainerBridge } from "../electron/container.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const IMAGE = process.env.PIWORK_IMAGE ?? "piwork-sandbox:spike";

function makeWorkspace() {
  const base = mkdtempSync(path.join(REPO_ROOT, ".smoke-tmp-"));
  const project = path.join(base, "project");
  const agent = path.join(base, "agent");
  mkdirSync(path.join(project, ".pi", "extensions"), { recursive: true });
  mkdirSync(agent, { recursive: true });
  writeFileSync(
    path.join(project, ".pi", "extensions", "spike-ui.ts"),
    "export default function(pi){pi.registerCommand('smoke-select',{description:'x',handler:async(_a,ctx)=>{const c=await ctx.ui.select('pick',['alpha','beta']);ctx.ui.notify('SMOKE_CHOICE='+String(c),'info');}});}\n",
  );
  writeFileSync(path.join(agent, "models.json"), JSON.stringify({
    providers: { ollama: { baseUrl: "http://host.docker.internal:11434/v1", api: "openai-completions", apiKey: "ollama", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: "gemma4:12b" }] } },
  }));
  writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "ollama", defaultModel: "gemma4:12b" }));
  writeFileSync(path.join(agent, "auth.json"), JSON.stringify({ ollama: { type: "api_key", key: "ollama" } }));
  return { base, project, agent };
}

const ws = makeWorkspace();
const b = new ContainerBridge();
const seen = { hello: false, text: "", selectRoundTrip: false, notifyEcho: false, agentEnd: false };
let phase = 0;

b.on("stderr", (c) => process.stderr.write(`[c] ${c}`));
b.on("error", (e) => console.error("[bridge error]", e.message));
b.on("hello", (h) => {
  seen.hello = h.protocolVersion === 1;
  console.error(`hello: pi=${h.piVersion} session=${h.sessionId}`);
  b.getState();
});
b.on("response", (r) => {
  console.error(`response ${r.command} success=${r.success}${r.error ? " err=" + r.error : ""}`);
  if (r.command === "get_state" && phase === 0) {
    phase = 1;
    b.prompt('Reply with EXACTLY the text "PIWORK_OK" and nothing else. Do not use tools.', { id: "p1" });
  }
});
b.on("event", (e) => {
  if (e.type === "message_update") {
    const ev = e.assistantMessageEvent;
    if (ev?.type === "text_delta") { seen.text += ev.delta; process.stderr.write(ev.delta); }
  } else if (e.type === "agent_end") {
    seen.agentEnd = true;
    if (phase === 1) { phase = 2; console.error("\n-> invoking /smoke-select"); b.prompt("/smoke-select", { id: "p2" }); }
  }
});
b.on("ui_request", (r) => {
  console.error(`ui_request ${r.method}`);
  if (r.method === "select") { seen.selectRoundTrip = true; b.respondUi({ type: "extension_ui_response", id: r.id, value: r.options?.[0] ?? "" }); }
  else if (r.method === "notify" && String(r.message).includes("SMOKE_CHOICE=alpha")) seen.notifyEcho = true;
});

b.start({ workspace: ws.project, image: IMAGE, agentHostDir: ws.agent, addHostGateway: true });

const started = Date.now();
const poll = setInterval(async () => {
  const done = seen.hello && seen.text.includes("PIWORK_OK") && seen.selectRoundTrip;
  if (done || Date.now() - started > 120_000) {
    clearInterval(poll);
    await b.stop();
    try { rmSync(ws.base, { recursive: true, force: true }); } catch {}
    console.error("\n\n=========== SHELL BRIDGE SMOKE ===========");
    console.error(`handshake            : ${seen.hello ? "YES" : "no"}`);
    console.error(`streamed PIWORK_OK   : ${seen.text.includes("PIWORK_OK") ? "YES" : "no"}`);
    console.error(`select round-trip    : ${seen.selectRoundTrip ? "YES" : "no"}`);
    console.error(`notify echo (alpha)  : ${seen.notifyEcho ? "YES" : "no"}`);
    const pass = seen.hello && seen.text.includes("PIWORK_OK") && seen.selectRoundTrip;
    console.error(`\nRESULT: ${pass ? "PASS ✅" : "FAIL ❌"}`);
    console.error("==========================================");
    process.exit(pass ? 0 : 1);
  }
}, 500);
