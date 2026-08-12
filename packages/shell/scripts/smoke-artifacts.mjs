#!/usr/bin/env node
/**
 * Verify the show_artifact → viewer plumbing (new model): calling ctx.ui.showArtifact({ file })
 * emits an `artifact` intent carrying `file`, which the shell opens host-side. Also confirms
 * piwork-artifacts loads. Driven by a throwaway project command (deterministic — no LLM
 * tool-calling; whether a model chooses to call show_artifact is exercised in real use).
 * The old `.artifacts/` folder watcher is retired.
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
mkdirSync(path.join(project, ".pi", "extensions"), { recursive: true });
mkdirSync(agent, { recursive: true });
writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "ollama", defaultModel: "gemma4:12b" }));
writeFileSync(path.join(project, "report.md"), "# Report\n");
// Throwaway command that drives the same intent path show_artifact uses (file present).
writeFileSync(path.join(project, ".pi", "extensions", "present.ts"),
  `export default function (pi) { pi.registerCommand("present", { description: "t", handler: async (_a, ctx) => ctx.ui.showArtifact({ key: "file:report.md", title: "Report", file: "report.md" }) }); }`);

console.error("=== install piwork-artifacts globally (confirms it loads) ===");
execFileSync(DOCKER, [
  "run", "--rm", "--entrypoint", "/opt/pi-host/node_modules/.bin/pi",
  "-v", `${agent}:/root/.pi/agent`, "-v", `${SUITE}:/opt/piwork-suite:ro`,
  IMAGE, "install", "/opt/piwork-suite/piwork-artifacts",
], { stdio: "inherit" });

const b = new ContainerBridge();
const seen = { file: null };
b.on("stderr", () => {});
b.on("error", (e) => console.error("bridge error", e.message));
b.on("ui_request", (r) => {
  if (r.method !== "artifact") return;
  console.error(`artifact intent: key=${r.key} file=${r.file ?? "(none)"}`);
  if (typeof r.file === "string") seen.file = r.file;
});
b.on("hello", () => setTimeout(() => b.prompt("/present"), 1500));
b.start({
  workspace: project, image: IMAGE, agentHostDir: agent, addHostGateway: true,
  extraDockerArgs: ["-v", `${SUITE}:/opt/piwork-suite:ro`],
});

setTimeout(async () => {
  await b.stop();
  try { rmSync(base, { recursive: true, force: true }); } catch {}
  console.error("\n=========== ARTIFACTS SMOKE ===========");
  console.error(`showArtifact({file}) → intent w/ file : ${seen.file ? `YES (${seen.file})` : "no"}`);
  const pass = seen.file === "report.md";
  console.error(`\nRESULT: ${pass ? "PASS ✅" : "FAIL ❌"}`);
  console.error("=======================================");
  process.exit(pass ? 0 : 1);
}, 20000);
