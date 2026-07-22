import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * PowerRules extension for Piwork project.
 * Injects memory.md and design doc references into the system prompt on every turn,
 * so they survive compaction and new sessions automatically.
 */
export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const memoryPath = path.join(cwd, "memory.md");
  const designPath = path.join(cwd, "pi-cowork-design.md");

  function readIfExists(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  // Inject into system prompt on every turn — this survives compaction.
  pi.on("before_agent_start", (event) => {
    const memoryContent = readIfExists(memoryPath);
    const hasDesign = fs.existsSync(designPath);

    let injected = "";

    // Rule B: Always use pi-cowork-design.md as the high-level plan
    if (hasDesign) {
      injected += `
## Project Design Plan
You are working on the Piwork project. Always refer to \`pi-cowork-design.md\` for the high-level plan and architecture. When in doubt about what to build or how, read it first.\n`;
    }

    // Rule A: Check memory.md every turn for progress/issues/state
    if (memoryContent) {
      injected += `
## Project Memory (last updated state)
${memoryContent}\n`;
    } else {
      injected += `
## Project Memory
No memory.md found at ${memoryPath}. Create one if you make progress or encounter issues.\n`;
    }

    // Rule C: After compaction, always re-read memory.md by having it here automatically
    injected += `
## Active Working Rules
- Always update \`memory.md\` when you complete work or hit blockers. Write concise bullet points.
- Before starting any Piwork task, check if \`pi-cowork-design.md\` has relevant guidance.
- When implementing extensions, follow the Pi Extension API (\`ExtensionAPI\`, \`ctx.ui\`, \`TypeObject\`).
`;

    event.systemPrompt += injected;
  });

  // On session start, notify the user what's loaded
  pi.on("session_start", async (_event, ctx) => {
    const hasMemory = fs.existsSync(memoryPath);
    const hasDesign = fs.existsSync(designPath);
    ctx.ui.notify(
      `Powerrules: memory=${hasMemory ? "found" : "missing"}, design=${hasDesign ? "found" : "missing"}`,
      "info",
    );
  });
}
