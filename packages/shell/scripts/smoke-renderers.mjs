#!/usr/bin/env node
/** Phase 3: the file→artifact renderer contract. Loads the CSV renderer extension, invokes
 *  the base /piwork-render-file dispatch command on a .csv, and confirms it emits an
 *  artifact whose HTML is a rendered <table> (not raw text). No model call needed. */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContainerBridge } from "../electron/container.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const IMAGE = process.env.PIWORK_IMAGE ?? "piwork-sandbox:spike";

const base = mkdtempSync(path.join(REPO, ".smoke-tmp-"));
const ws = path.join(base, "cwd");
const agent = path.join(base, "agent");
mkdirSync(ws, { recursive: true });
mkdirSync(path.join(agent, "extensions", "csv-renderer"), { recursive: true });
// Load the REAL renderer via a native global extension location (verified to load).
copyFileSync(path.join(REPO, "packages/piwork-renderers/extensions/csv.ts"), path.join(agent, "extensions", "csv-renderer", "index.ts"));
writeFileSync(path.join(ws, "data.csv"), "name,score\nada,42\ngrace,99\n");
writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { ollama: { baseUrl: "http://host.docker.internal:11434/v1", api: "openai-completions", apiKey: "ollama", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: "gemma4:12b" }] } } }));
writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "ollama", defaultModel: "gemma4:12b" }));
writeFileSync(path.join(agent, "auth.json"), JSON.stringify({ ollama: { type: "api_key", key: "ollama" } }));

const b = new ContainerBridge();
let html = "";
b.on("stderr", () => {});
b.on("error", () => {});
b.on("ui_request", (r) => { if (r.method === "artifact" && typeof r.html === "string") html = r.html; });
b.on("hello", () => b.prompt("/piwork-render-file data.csv", { id: "p1" }));
b.start({ workspace: ws, image: IMAGE, agentHostDir: agent, addHostGateway: true });

setTimeout(async () => {
  await b.stop();
  try { rmSync(base, { recursive: true, force: true }); } catch {}
  const hasTable = /<table>/.test(html);
  const hasHeader = /<th>name<\/th>/.test(html) && /<th>score<\/th>/.test(html);
  const hasCell = /<td>grace<\/td>/.test(html) && /<td>99<\/td>/.test(html);
  console.error("\n=========== FILE RENDERER (Phase 3) SMOKE ===========");
  console.error(`artifact emitted with HTML : ${html ? "YES" : "no"}`);
  console.error(`rendered as <table>        : ${hasTable ? "YES" : "no"}`);
  console.error(`header cells (name/score)  : ${hasHeader ? "YES" : "no"}`);
  console.error(`data cells (grace/99)      : ${hasCell ? "YES" : "no"}`);
  const pass = hasTable && hasHeader && hasCell;
  console.error(`\nRESULT: ${pass ? "PASS ✅" : "FAIL ❌"}`);
  console.error("=====================================================");
  process.exit(pass ? 0 : 1);
}, 30000);
