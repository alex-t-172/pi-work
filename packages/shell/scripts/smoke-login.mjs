#!/usr/bin/env node
// Isolates the shell's login path: drive ContainerBridge in login mode exactly like
// main.ts does, and print every emitted event. If login_providers shows here, the bug
// is in main/renderer IPC wiring; if not, it's in ContainerBridge/container.
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { ContainerBridge } from "../electron/container.ts";

const AGENT = path.join(os.homedir(), ".piwork-agent");
const IMAGE = process.env.PIWORK_IMAGE ?? "piwork-sandbox:spike";
void fileURLToPath;

const b = new ContainerBridge();
b.on("hello", (h) => console.error("HELLO", JSON.stringify(h)));
b.on("event", (e) => console.error("EVENT", JSON.stringify(e).slice(0, 200)));
b.on("ui_request", (r) => console.error("UI", JSON.stringify(r).slice(0, 120)));
b.on("response", (r) => console.error("RESP", JSON.stringify(r).slice(0, 120)));
b.on("stderr", (c) => process.stderr.write(`[c] ${c}`));
b.on("error", (e) => console.error("ERROR", e.message));
b.on("exit", (code) => console.error("EXIT", code));

console.error(`starting login container (agent=${AGENT})`);
b.start({
  workspace: AGENT,
  image: IMAGE,
  addHostGateway: true,
  agentHostDir: AGENT,
  env: { PIWORK_MODE: "login" },
});

setTimeout(async () => {
  await b.stop();
  process.exit(0);
}, 8000);
