#!/usr/bin/env node
/**
 * Dev launcher with auto-reload for the Electron main/preload bundles.
 *
 * The renderer is served + hot-reloaded by Vite. The main process and preload are NOT
 * (they're a separate Node bundle), so previously editing main.ts left a STALE main
 * running while the renderer updated — a silent-failure trap. Here we watch/rebuild
 * main+preload with esbuild and relaunch Electron whenever they change.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";

const DEV_URL = "http://localhost:5178";
// Resolve the Electron binary directly. Spawning via `npx electron` orphans the real
// Electron process when we kill the wrapper, leaving a stale main running.
const ELECTRON_BIN = createRequire(import.meta.url)("electron");

async function waitForVite(timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(DEV_URL)).ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  return false;
}

let electron; // current Electron child
let relaunchTimer;

function relaunchElectron() {
  clearTimeout(relaunchTimer);
  relaunchTimer = setTimeout(() => {
    if (electron) {
      electron.removeAllListeners("exit");
      electron.kill();
    }
    process.stderr.write("[dev] (re)launching Electron\n");
    electron = spawn(ELECTRON_BIN, ["."], {
      stdio: "inherit",
      env: { ...process.env, PIWORK_DEV_URL: DEV_URL },
    });
    electron.on("exit", (code) => {
      // If the user quits the window, exit the whole dev process.
      process.stderr.write(`[dev] Electron exited (${code}); stopping.\n`);
      process.exit(code ?? 0);
    });
  }, 150);
}

async function main() {
  process.stderr.write("[dev] waiting for Vite…\n");
  if (!(await waitForVite())) {
    process.stderr.write("[dev] Vite did not come up; is `vite` running?\n");
    process.exit(1);
  }

  const ctx = await esbuild.context({
    entryPoints: ["electron/main.ts", "electron/preload.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    outdir: "dist/electron",
    logLevel: "info",
    plugins: [
      {
        name: "relaunch-electron",
        setup(build) {
          build.onEnd((result) => {
            if (result.errors.length) {
              process.stderr.write("[dev] main build failed; keeping previous Electron\n");
              return;
            }
            relaunchElectron();
          });
        },
      },
    ],
  });
  await ctx.watch();
  process.stderr.write("[dev] watching electron/ for changes\n");
}

main();
