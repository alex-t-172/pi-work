#!/usr/bin/env node
/**
 * Verify the self-authoring loop primitives (no package install needed — both are
 * injected by pi-host / baked into the image):
 *   - the always-on /piwork-reload command is present
 *   - the baked "writing-piwork-extensions" skill is available (as skill:… in get_commands)
 *   - /piwork-reload triggers a live reload (its notify fires)
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContainerBridge } from "../electron/container.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const IMAGE = process.env.PIWORK_IMAGE ?? "piwork-sandbox:spike";

const base = mkdtempSync(path.join(REPO, ".smoke-tmp-"));
const project = path.join(base, "project");
const agent = path.join(base, "agent");
mkdirSync(project, { recursive: true });
mkdirSync(agent, { recursive: true });
writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "ollama", defaultModel: "gemma4:12b" }));

const b = new ContainerBridge();
const seen = { reloadCmd: false, skill: false, reloadFired: false };
b.on("stderr", () => {});
b.on("error", (e) => console.error("bridge error", e.message));
b.on("hello", () => b.send({ id: "gc", type: "get_commands" }));
b.on("response", (r) => {
  if (r.command === "get_commands" && r.success) {
    const names = (r.data?.commands ?? []).map((c) => c.name);
    console.error("commands:", names.join(", "));
    seen.reloadCmd = names.includes("piwork-reload");
    seen.skill = names.some((n) => n === "skill:writing-piwork-extensions");
    if (seen.reloadCmd) b.send({ type: "prompt", message: "/piwork-reload" }); // exercise live reload
  }
});
b.on("ui_request", (r) => {
  if (r.method === "notify" && String(r.message ?? "").includes("Reloading resources")) {
    seen.reloadFired = true;
    console.error(`notify: ${r.message}`);
  }
});
b.on("event", () => {});
b.start({ workspace: project, image: IMAGE, agentHostDir: agent, addHostGateway: true });

setTimeout(async () => {
  await b.stop();
  try { rmSync(base, { recursive: true, force: true }); } catch {}
  console.error("\n=========== AUTHORING LOOP SMOKE ===========");
  console.error(`/piwork-reload command present : ${seen.reloadCmd ? "YES" : "no"}`);
  console.error(`authoring skill available      : ${seen.skill ? "YES" : "no"}`);
  console.error(`live reload fired              : ${seen.reloadFired ? "YES" : "no"}`);
  const pass = seen.reloadCmd && seen.skill && seen.reloadFired;
  console.error(`\nRESULT: ${pass ? "PASS ✅" : "FAIL ❌"}`);
  console.error("============================================");
  process.exit(pass ? 0 : 1);
}, 15000);
