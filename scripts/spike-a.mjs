#!/usr/bin/env node
/**
 * Phase 0 — Spike A harness (runs on the host).
 *
 * Proves the core Piwork seam end to end:
 *   1. Build the sandbox image (pi-host + pinned Pi SDK).
 *   2. `docker run -i` it with the project + a credential mounted, stdio piped.
 *   3. Speak Pi's RPC/JSONL protocol over that pipe:
 *        - send a `prompt`, confirm streamed text deltas + a `prompt` response,
 *        - answer ANY `extension_ui_request` the agent raises (proves the
 *          serialized ctx.ui round-trip),
 *        - close stdin to trigger a clean container shutdown.
 *
 * Framing is strict LF-only JSONL (see Pi docs/rpc.md): split on "\n", strip a
 * trailing "\r", never use readline.
 *
 * Usage: node scripts/spike-a.mjs
 * Env:   PIWORK_DOCKER (docker binary), PIWORK_SKIP_BUILD=1 to reuse the image.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync, rmSync } from "node:fs";
import path from "node:path";

const DOCKER = process.env.PIWORK_DOCKER || "docker";
const IMAGE = "piwork-sandbox:spike";
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", ...opts });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function build() {
  console.error(`\n=== [1/3] docker build ${IMAGE} ===`);
  await run(DOCKER, ["build", "-t", IMAGE, "-f", path.join(REPO_ROOT, "images", "Dockerfile"), REPO_ROOT]);
}

function makeTestWorkspace() {
  // IMPORTANT: create under the repo (/Users/...), which Rancher Desktop shares with
  // the VM. macOS /var/folders temp dirs are NOT shared, and single-file bind mounts
  // from unshared paths silently become empty *directories* inside the container
  // (EISDIR). We also mount whole directories, not individual files, for robustness.
  const base = mkdtempSync(path.join(REPO_ROOT, ".spike-tmp-"));
  const project = path.join(base, "project");
  const agent = path.join(base, "agent");
  mkdirSync(path.join(project, "src"), { recursive: true });
  mkdirSync(agent, { recursive: true });

  writeFileSync(path.join(project, "README.md"), "# Spike workspace\n\nScratch project for the Piwork Spike A test.\n");
  writeFileSync(path.join(project, "src", "hello.txt"), "hello from the sandbox\n");

  // A project extension that exercises the blocking ctx.ui.select round-trip — the
  // linchpin of the Piwork UI-intent contract. Loaded by DefaultResourceLoader from
  // .pi/extensions/ (proves extension loading from the container FS too).
  mkdirSync(path.join(project, ".pi", "extensions"), { recursive: true });
  writeFileSync(
    path.join(project, ".pi", "extensions", "spike-ui.ts"),
    [
      "export default function (pi) {",
      "  pi.registerCommand('spike-select', {",
      "    description: 'Piwork spike: exercise ctx.ui.select',",
      "    handler: async (_args, ctx) => {",
      "      const choice = await ctx.ui.select('Piwork spike — pick one', ['alpha', 'beta', 'gamma']);",
      "      ctx.ui.notify('SPIKE_CHOICE=' + String(choice), 'info');",
      "    },",
      "  });",
      "}",
      "",
    ].join("\n"),
  );

  // Ollama pointed at the host daemon (reachable via host.docker.internal). Makes the
  // spike self-contained — a local model, no cloud key needed.
  const models = {
    providers: {
      ollama: {
        baseUrl: "http://host.docker.internal:11434/v1",
        api: "openai-completions",
        apiKey: "ollama",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: "gemma4:12b" }, { id: "qwen3.6:27b", reasoning: true }],
      },
    },
  };
  writeFileSync(path.join(agent, "models.json"), JSON.stringify(models, null, 2));
  // Startup default model. NO `packages` array — that would trigger a startup npm
  // install whose subprocess writes to fd 1 (our JSONL protocol channel).
  writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "ollama", defaultModel: "gemma4:12b" }, null, 2));
  // AuthStorage keys credentials by provider id; Ollama ignores the value.
  writeFileSync(path.join(agent, "auth.json"), JSON.stringify({ ollama: { type: "api_key", key: "ollama" } }, null, 2));
  return { base, project, agent };
}

async function main() {
  if (process.env.PIWORK_SKIP_BUILD !== "1") await build();

  const ws = makeTestWorkspace();
  console.error(`\n=== [2/3] docker run (workspace=${ws.project}) ===`);

  const args = [
    "run", "-i", "--rm",
    // Let the container reach the host's Ollama daemon.
    "--add-host=host.docker.internal:host-gateway",
    "-v", `${ws.project}:/workspace`,
    // Mount the whole agent dir (auth/models/settings). Directory mounts are robust;
    // single-file mounts are fragile on macOS/Rancher. Writable so sessions can persist.
    "-v", `${ws.agent}:/root/.pi/agent`,
    IMAGE,
  ];

  const proc = spawn(DOCKER, args, { stdio: ["pipe", "pipe", "inherit"] });

  const send = (obj) => {
    const line = JSON.stringify(obj) + "\n";
    process.stderr.write(`\n>>> ${line}`);
    proc.stdin.write(line);
  };

  // ---- outcomes we want to observe ----
  const seen = { hello: false, promptResponse: false, textDeltas: 0, textBuf: "", uiRequests: 0, agentEnds: 0, error: null, modelSet: null, selectRoundTrip: false, notifyEcho: false };
  let prompted = false;
  let selectPhaseStarted = false;
  let selectPhaseAt = 0;

  // ---- strict LF-only JSONL reader ----
  let buffer = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim()) onMessage(line);
    }
  });

  const rawLog = "/private/tmp/claude-501/-Users-alexthoma-Documents-alex-pi-work/e9bb1c10-6c7b-4fe1-9ede-a93f1beab137/scratchpad/spike-a-raw.jsonl";
  function onMessage(line) {
    try { appendFileSync(rawLog, line + "\n"); } catch {}
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      console.error(`[harness] non-JSON stdout line: ${line}`);
      return;
    }
    // Trace every message_update subtype to see exactly what the API streams.
    if (msg.type === "message_update") {
      console.error(`[mu] ${msg.assistantMessageEvent?.type}`);
    }

    if (msg.type === "piwork_hello") {
      console.error(`<<< piwork_hello protocol=v${msg.protocolVersion} pi=${msg.piVersion} session=${msg.sessionId}`);
      seen.hello = msg.protocolVersion === 1;
      return;
    }

    if (msg.type === "response") {
      console.error(`<<< response command=${msg.command} success=${msg.success}${msg.error ? " error=" + msg.error : ""}`);
      if (!msg.success) seen.error = msg.error;
      if (msg.command === "get_state" && msg.success) {
        const model = msg.data?.model;
        seen.modelSet = model ? `${model.provider}/${model.id}` : "(none)";
        console.error(`[harness] startup model = ${seen.modelSet}; prompting…`);
        if (!prompted) {
          prompted = true;
          send({ id: "p1", type: "prompt", message: promptText });
        }
        return;
      }
      if (msg.command === "prompt" && msg.success) seen.promptResponse = true;
      return;
    }

    if (msg.type === "extension_ui_request") {
      seen.uiRequests++;
      console.error(`<<< extension_ui_request method=${msg.method} id=${msg.id} title=${JSON.stringify(msg.title ?? "")}`);
      // Answer whatever the agent asks so the round-trip completes.
      if (msg.method === "select") {
        seen.selectRoundTrip = true;
        send({ type: "extension_ui_response", id: msg.id, value: msg.options?.[0] ?? "" });
      } else if (msg.method === "confirm") send({ type: "extension_ui_response", id: msg.id, confirmed: true });
      else if (msg.method === "input") send({ type: "extension_ui_response", id: msg.id, value: "piwork" });
      else if (msg.method === "editor") send({ type: "extension_ui_response", id: msg.id, value: "piwork" });
      else if (msg.method === "notify") {
        if (typeof msg.message === "string" && msg.message.includes("SPIKE_CHOICE=alpha")) seen.notifyEcho = true;
      }
      // notify/setStatus/setWidget/setTitle/set_editor_text are fire-and-forget; no reply.
      return;
    }

    // AgentSessionEvent passthrough
    switch (msg.type) {
      case "message_update": {
        const ev = msg.assistantMessageEvent;
        if (ev?.type === "text_delta") {
          seen.textDeltas++;
          seen.textBuf += ev.delta;
          process.stderr.write(ev.delta);
        } else if (ev?.type === "error") {
          console.error(`\n<<< assistant ERROR delta: reason=${ev.reason} ${ev.error ?? ""}`);
          seen.error = seen.error ?? `assistant error: ${ev.reason} ${ev.error ?? ""}`;
        } else if (ev?.type === "done") {
          console.error(`\n<<< assistant done: reason=${ev.reason}`);
        }
        break;
      }
      case "tool_execution_start":
        console.error(`\n<<< tool_execution_start ${msg.toolName}`);
        break;
      case "auto_retry_start":
        console.error(`\n<<< auto_retry_start`);
        break;
      case "message_start":
        console.error(`\n<<< message_start role=${msg.message?.role ?? "?"}`);
        break;
      case "message_end":
        console.error(`<<< message_end`);
        break;
      case "turn_end":
        console.error(`<<< turn_end toolResults=${msg.toolResults?.length ?? 0}`);
        break;
      case "agent_end": {
        seen.agentEnds++;
        console.error(`\n<<< agent_end (#${seen.agentEnds}) willRetry=${msg.willRetry} newMessages=${msg.messages?.length ?? 0}`);
        // Extract assistant text from the final messages to see where output went.
        for (const m of msg.messages ?? []) {
          const parts = Array.isArray(m.content) ? m.content : [];
          const text = parts.filter((p) => p?.type === "text").map((p) => p.text).join("");
          console.error(`    [msg role=${m.role}] ${JSON.stringify((text || JSON.stringify(parts)).slice(0, 200))}`);
          if (m.role === "assistant" && text) seen.textBuf += text;
        }
        break;
      }
      case "extension_error":
        console.error(`\n<<< extension_error ${msg.extensionPath}: ${msg.error}`);
        break;
    }
  }

  // Drive the conversation once the container is up.
  const promptText =
    'Reply with EXACTLY the text "PIWORK_OK" and nothing else. Do not use any tools.';

  // Kick off: confirm the startup model (from settings), then prompt.
  setTimeout(() => send({ id: "m1", type: "get_state" }), 1200);

  // Finish: (phase 1) prompt completes -> (phase 2) invoke the ctx.ui.select command
  // -> select round-trip completes -> close stdin for clean shutdown.
  const deadline = 120_000;
  const started = Date.now();
  const poll = setInterval(() => {
    const phase1Done = seen.promptResponse && seen.agentEnds >= 1;
    if (phase1Done && !selectPhaseStarted) {
      selectPhaseStarted = true;
      selectPhaseAt = Date.now();
      console.error("\n\n=== phase 2: invoke /spike-select (ctx.ui.select round-trip) ===");
      send({ id: "p2", type: "prompt", message: "/spike-select" });
    }
    const phase2Done = seen.selectRoundTrip; // the blocking dialog round-trip is the key proof
    const phase2Timeout = selectPhaseStarted && Date.now() - selectPhaseAt > 20_000;
    if ((phase1Done && phase2Done) || (phase1Done && phase2Timeout) || Date.now() - started > deadline) {
      clearInterval(poll);
      console.error("\n\n=== [3/3] closing stdin (clean shutdown) ===");
      proc.stdin.end();
      setTimeout(() => proc.kill("SIGTERM"), 5000);
    }
  }, 500);

  proc.on("exit", (code) => {
    try { rmSync(ws.base, { recursive: true, force: true }); } catch {}
    const gotText = seen.textBuf.includes("PIWORK_OK");
    console.error("\n\n================ SPIKE A RESULT ================");
    console.error(`container exit code    : ${code}`);
    console.error(`handshake (piwork_hello): ${seen.hello ? "YES (v1)" : "no"}`);
    console.error(`prompt response        : ${seen.promptResponse ? "YES" : "no"}`);
    console.error(`text streamed          : ${seen.textDeltas} deltas (contains PIWORK_OK: ${gotText ? "YES" : "no"})`);
    console.error(`agent_end events       : ${seen.agentEnds}`);
    console.error(`ctx.ui.select roundtrip: ${seen.selectRoundTrip ? "YES" : "no"}`);
    console.error(`ctx.ui.notify echo     : ${seen.notifyEcho ? "YES (choice=alpha)" : "no"}`);
    console.error(`total ctx.ui intents   : ${seen.uiRequests}`);
    if (seen.error) console.error(`error                  : ${seen.error}`);
    const core = seen.promptResponse && gotText && seen.agentEnds >= 1;
    const ui = seen.selectRoundTrip;
    console.error(`\ncore seam (embed+stream+framing over docker) : ${core ? "PASS ✅" : "FAIL ❌"}`);
    console.error(`ctx.ui intent round-trip (blocking select)   : ${ui ? "PASS ✅" : "FAIL ❌"}`);
    const pass = core && ui;
    console.error(`\nSPIKE A: ${pass ? "PASS ✅" : "FAIL ❌"}`);
    console.error("================================================");
    process.exit(pass ? 0 : 1);
  });
}

main().catch((e) => {
  console.error("[harness] fatal:", e);
  process.exit(1);
});
