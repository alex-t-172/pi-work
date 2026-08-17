// verify-builtins — asserts every default built-in (from built-ins.json) loads from the BAKED
// image with zero errors and registers its expected tools. The automated version of the manual
// fresh-store check; catches a built-in breaking (a Pi bump, a bad edit, a missing Dockerfile
// bake, or a manifest mismatch). Run via scripts/verify-builtins.sh or in CI.

import * as os from "node:os";
import * as fs from "node:fs";
import * as nodePath from "node:path";

const SDK = "/opt/pi-host/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const MANIFEST = "/opt/pi-host/built-ins.json";

let failures = 0;
const pass = (n, x) => console.log(`  ✓ ${n}${x ? ` (${x})` : ""}`);
const fail = (n, m) => { failures++; console.log(`  ✗ ${n} — ${m}`); };

console.log("verify-builtins: checking the default built-in extensions load\n");

const builtins = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const { createAgentSession, SessionManager } = await import(SDK);

// A fresh store seeded exactly as the shell's ensureStoreProvisioned() does — no dev-mount, so
// this exercises the BAKED built-ins.
const agentDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "vb-store-"));
fs.writeFileSync(nodePath.join(agentDir, "settings.json"), JSON.stringify({ packages: builtins.map((b) => b.source) }, null, 2));
const cwd = fs.mkdtempSync(nodePath.join(os.tmpdir(), "vb-ws-"));

let session, extensionsResult;
try {
  ({ session, extensionsResult } = await createAgentSession({ cwd, agentDir, sessionManager: SessionManager.inMemory() }));
  pass("session builds against a fresh provisioned store");
} catch (e) {
  fail("session builds", String(e?.message ?? e).split("\n")[0]);
  console.log("\nverify-builtins: FAILED");
  process.exit(1);
}

const errs = extensionsResult?.errors ?? [];
if (errs.length === 0) pass("extension load errors == 0");
else fail("extension load errors == 0", errs.map((e) => `${e.path}: ${String(e.error).split("\n")[0]}`).join("  ||  "));

const loadedPaths = (extensionsResult?.extensions ?? []).map((e) => e.path);
const tools = new Set((session.getAllTools?.() ?? []).map((t) => t.name));

for (const b of builtins) {
  if (!loadedPaths.some((p) => p.includes(`/${b.name}/`) || p.includes(`/${b.name}.`) || p.includes(`/${b.name}`))) {
    fail(`built-in loaded: ${b.name}`, "not among loaded extensions");
    continue;
  }
  const missing = (b.tools ?? []).filter((t) => !tools.has(t));
  if (missing.length) fail(`${b.name} tools`, `missing: ${missing.join(", ")}`);
  else pass(b.name, (b.tools ?? []).join(","));
}

try { await session?.dispose?.(); } catch { /* ignore */ }
try { fs.rmSync(agentDir, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(failures === 0 ? "\nverify-builtins: ALL BUILT-INS OK ✓" : `\nverify-builtins: ${failures} FAILED ✗`);
process.exit(failures === 0 ? 0 : 1);
