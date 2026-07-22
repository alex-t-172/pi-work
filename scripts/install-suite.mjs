#!/usr/bin/env node
/**
 * Install a Piwork Suite package into an agent store via `pi install` (local path).
 *
 * Usage: node scripts/install-suite.mjs [pkgName=piwork-checkpoint] [agentDir=~/.piwork-agent]
 *
 * The package is referenced (not copied), so run the shell with
 *   PIWORK_SUITE_DIR=<repo>/packages
 * so the reference (/opt/piwork-suite/<pkg>) resolves inside session containers.
 * (The eventual production path is `pi install npm:<pkg>`, which copies into the volume.)
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const pkg = process.argv[2] || "piwork-checkpoint";
const agentDir = process.argv[3] || path.join(os.homedir(), ".piwork-agent");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suite = path.join(repo, "packages");
const IMAGE = process.env.PIWORK_IMAGE || "piwork-sandbox:spike";
const DOCKER = process.env.PIWORK_DOCKER || "docker";

console.error(`Installing ${pkg} into ${agentDir} …`);
execFileSync(
  DOCKER,
  [
    "run", "--rm", "--entrypoint", "/opt/pi-host/node_modules/.bin/pi",
    "-v", `${agentDir}:/root/.pi/agent`,
    "-v", `${suite}:/opt/piwork-suite:ro`,
    IMAGE, "install", `/opt/piwork-suite/${pkg}`,
  ],
  { stdio: "inherit" },
);
console.error(`\n✓ Installed ${pkg}. Start the shell with:`);
console.error(`  PIWORK_AGENT_DIR=${agentDir} PIWORK_SUITE_DIR=${suite} PIWORK_ADD_HOST_GATEWAY=1 npm run dev`);
