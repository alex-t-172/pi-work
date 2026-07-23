#!/usr/bin/env node
/**
 * Verify piwork-tree / command-side shim: after a couple of turns, /piwork-tree emits a
 * sessionTree intent with message nodes; /piwork-rewind <id> navigates back (fires a
 * "Rewound" notify + a fresh tree) and get_messages shrinks.
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
writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { ollama: { baseUrl: "http://host.docker.internal:11434/v1", api: "openai-completions", apiKey: "ollama", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: "gemma4:12b" }] } } }));
writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "ollama", defaultModel: "gemma4:12b" }));
writeFileSync(path.join(agent, "auth.json"), JSON.stringify({ ollama: { type: "api_key", key: "ollama" } }));

function userNodes(nodes, out = []) {
  for (const n of nodes ?? []) {
    if (n.type === "message" && n.role === "user") out.push(n);
    userNodes(n.children, out);
  }
  return out;
}

const b = new ContainerBridge();
const seen = { trees: 0, firstUserCount: 0, rewound: false, msgCounts: [] };
let phase = 0;
b.on("stderr", () => {});
b.on("error", (e) => console.error("bridge error", e.message));
b.on("hello", () => b.prompt('Reply with just "A".', { id: "p1" }));
b.on("event", (e) => {
  if (e.type === "agent_end") {
    if (phase === 0) { phase = 1; b.prompt('Reply with just "B".', { id: "p2" }); }
    else if (phase === 1) { phase = 2; b.send({ id: "tree", type: "prompt", message: "/piwork-tree" }); }
  }
});
b.on("response", (r) => { if (r.command === "get_messages" && r.success) seen.msgCounts.push((r.data?.messages ?? []).length); });
b.on("ui_request", (r) => {
  if (r.method === "notify" && String(r.message ?? "").includes("Rewound")) seen.rewound = true;
  if (r.method !== "sessionTree") return;
  seen.trees++;
  const users = userNodes(r.tree);
  console.error(`sessionTree #${seen.trees}: ${users.length} user node(s)`);
  if (seen.trees === 1) {
    seen.firstUserCount = users.length;
    b.send({ id: "m1", type: "get_messages" }); // count before rewind
    const target = users[0]; // rewind to the FIRST user turn
    if (target) setTimeout(() => b.send({ id: "rw", type: "prompt", message: `/piwork-rewind ${target.id}` }), 300);
  } else if (seen.trees === 2) {
    setTimeout(() => b.send({ id: "m2", type: "get_messages" }), 300); // count after rewind
  }
});
b.start({ workspace: project, image: IMAGE, agentHostDir: agent, addHostGateway: true });

setTimeout(async () => {
  await b.stop();
  try { rmSync(base, { recursive: true, force: true }); } catch {}
  const [before, after] = seen.msgCounts;
  console.error("\n=========== SESSION TREE SMOKE ===========");
  console.error(`tree emitted with >=2 user nodes : ${seen.firstUserCount >= 2 ? "YES" : "no"} (${seen.firstUserCount})`);
  console.error(`rewind fired (navigateTree)      : ${seen.rewound ? "YES" : "no"}`);
  console.error(`second tree after rewind         : ${seen.trees >= 2 ? "YES" : "no"}`);
  console.error(`messages shrank after rewind     : ${before != null && after != null ? `${before} → ${after} ${after < before ? "YES" : "no"}` : "n/a"}`);
  const pass = seen.firstUserCount >= 2 && seen.rewound && seen.trees >= 2 && before != null && after != null && after < before;
  console.error(`\nRESULT: ${pass ? "PASS ✅" : "FAIL ❌"}`);
  console.error("==========================================");
  process.exit(pass ? 0 : 1);
}, 90000);
