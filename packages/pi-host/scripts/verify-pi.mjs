// verify-pi — asserts the exact Pi SDK contract pi-host binds to, INSIDE the image.
//
// The point: catch a Pi upgrade's breakage in seconds (removed export, extension that no
// longer loads, auth/login surface gone) instead of hunting through the GUI. It reuses
// pi-host's REAL createRuntime + piworkBaseExtension so it tests the actual binding, not a
// re-implementation. See packages/pi-host/UPGRADING-PI.md.
//
// Run (via the wrapper): packages/pi-host/scripts/verify-pi.sh
// Or directly inside the image:
//   node --experimental-transform-types /opt/pi-host/scripts/verify-pi.mjs
//
// Exit 0 = all checks passed; non-zero = at least one failed (prints which).

import * as os from "node:os";
import * as fs from "node:fs";
import * as nodePath from "node:path";

const SDK = "/opt/pi-host/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const HOST = "/opt/pi-host/src/index.ts";

let failures = 0;
const pass = (name, extra) => console.log(`  ✓ ${name}${extra ? ` (${extra})` : ""}`);
const fail = (name, msg) => {
  failures++;
  console.log(`  ✗ ${name} — ${msg}`);
};

console.log("verify-pi: checking the Pi SDK contract pi-host depends on\n");

// 1. Importing the SDK + pi-host validates EVERY named import pi-host binds (a removed
//    export — e.g. 0.80.8 dropping AuthStorage — throws right here).
let sdk, host;
try {
  sdk = await import(SDK);
  host = await import(HOST);
  pass("pi-host + SDK modules import (all named imports resolve)");
} catch (e) {
  fail("pi-host + SDK modules import", String(e?.message ?? e).split("\n")[0]);
  console.log("\nverify-pi: FAILED (cannot import — nothing else can run)");
  process.exit(1);
}

const { SessionManager, getAgentDir, ModelRuntime } = sdk;
const agentDir = getAgentDir();
const cwd = fs.mkdtempSync(nodePath.join(os.tmpdir(), "verify-pi-ws-"));

// Mirror pi-host's startup so extension binding (adapter status UI touches the theme
// singleton) doesn't throw for a reason unrelated to the upgrade.
try {
  await host.initPiTheme();
} catch {
  /* non-fatal, same as pi-host */
}

// 2. pi-host's own createRuntime builds a full session — with ZERO extension load errors.
//    This single check catches pi-subagents-style load failures and a broken base extension.
let runtime;
try {
  runtime = await host.createRuntime({ cwd, agentDir, sessionManager: SessionManager.inMemory() });
  pass("createRuntime builds a session");
} catch (e) {
  fail("createRuntime builds a session", String(e?.stack ?? e).split("\n").slice(0, 3).join(" | "));
}

if (runtime) {
  const errs = runtime.extensionsResult?.errors ?? [];
  if (errs.length === 0) pass("extension load errors == 0");
  else fail("extension load errors == 0", errs.map((e) => `${e.path}: ${String(e.error).split("\n")[0]}`).join("  ||  "));

  const exts = runtime.extensionsResult?.extensions ?? [];
  const commands = new Set(exts.flatMap((e) => [...(e.commands?.keys?.() ?? [])]));
  const needCmds = [
    "piwork-reload",
    "piwork-system-prompt",
    "piwork-tree",
    "piwork-rewind",
    "piwork-render-file",
    "piwork-mcp-auth",
    "piwork-mcp-status",
  ];
  const missingCmds = needCmds.filter((c) => !commands.has(c));
  if (missingCmds.length === 0) pass("base extension commands registered", `${needCmds.length}`);
  else fail("base extension commands registered", `missing: ${missingCmds.join(", ")}`);

  // 3. Built-in tools + the MCP adapter (connectors engine) are present.
  const tools = (runtime.session.getAllTools?.() ?? []).map((t) => t.name);
  const builtins = ["read", "bash", "edit", "write"];
  const missingTools = builtins.filter((t) => !tools.includes(t));
  if (missingTools.length === 0) pass("built-in tools present", builtins.join(","));
  else fail("built-in tools present", `missing: ${missingTools.join(", ")}`);

  const adapterExt = exts.some((e) => /pi-mcp-adapter/.test(e.path ?? ""));
  const adapterTool = tools.some((t) => /mcp/i.test(t));
  if (adapterExt || adapterTool) pass("mcp-adapter loaded (connectors engine)");
  else fail("mcp-adapter loaded (connectors engine)", "no adapter extension or mcp tool found");
}

// 4. Auth/login surface: ModelRuntime constructs and exposes OAuth-capable providers
//    (this is what the rewritten login.ts drives). No network, no real login.
try {
  const mr = await ModelRuntime.create({ authPath: nodePath.join(agentDir, "auth.json") });
  const provs = mr.getProviders();
  const oauth = provs.filter((p) => p?.auth?.oauth);
  if (provs.length > 0) pass("ModelRuntime providers listed", `${provs.length}`);
  else fail("ModelRuntime providers listed", "getProviders() empty");
  if (oauth.length > 0) pass("OAuth-capable providers present", oauth.map((p) => p.id).slice(0, 4).join(","));
  else fail("OAuth-capable providers present", "no provider exposes auth.oauth");
} catch (e) {
  fail("ModelRuntime.create()", String(e?.message ?? e).split("\n")[0]);
}

// 5. before_agent_start hook augments the system prompt (our Piwork environment layer).
//    Mock-invoke the exported base extension — no session needed.
try {
  let hook;
  host.piworkBaseExtension({ registerCommand() {}, on(ev, h) { if (ev === "before_agent_start") hook = h; } });
  if (!hook) {
    fail("before_agent_start augments system prompt", "hook not registered");
  } else {
    const out = hook({ systemPrompt: "BASE_PROMPT" });
    const sp = out?.systemPrompt ?? "";
    if (sp.startsWith("BASE_PROMPT") && sp.length > "BASE_PROMPT".length && /sandbox|Piwork/i.test(sp)) {
      pass("before_agent_start augments system prompt");
    } else {
      fail("before_agent_start augments system prompt", JSON.stringify(sp).slice(0, 80));
    }
  }
} catch (e) {
  fail("before_agent_start augments system prompt", String(e?.message ?? e).split("\n")[0]);
}

// Cleanup.
try {
  await runtime?.session?.dispose?.();
} catch {
  /* ignore */
}
try {
  fs.rmSync(cwd, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(failures === 0 ? "\nverify-pi: ALL CHECKS PASSED ✓" : `\nverify-pi: ${failures} CHECK(S) FAILED ✗`);
process.exit(failures === 0 ? 0 : 1);
