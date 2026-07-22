/**
 * piwork-connectors — bridges MCP servers (Slack, Notion, …) into Pi tools.
 *
 * Config is written by the Piwork shell (Connectors UI) to JSON files mounted into the
 * container: a global one plus an optional per-workspace one. On session start we connect
 * each enabled server via the MCP SDK, list its tools, and register each as a Pi tool
 * (namespaced `<serverId>__<tool>`). MCP tool shapes map ~1:1 onto Pi tools — the
 * inputSchema (raw JSON Schema) is accepted directly as the tool's `parameters`.
 *
 * The MCP client talks to servers over their OWN stdio/HTTP, never pi-host's protocol fd,
 * so there's no risk to the bridge stream.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

interface ServerConfig {
  id: string;
  label?: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

const GLOBAL_CONFIG = "/root/.piwork-connectors/global.json";
function projectConfig(): string | null {
  const key = process.env.PIWORK_WS_KEY;
  return key ? `/root/.piwork-connectors/proj-${key}.json` : null;
}

function readServers(file: string | null): ServerConfig[] {
  if (!file) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed.servers) ? parsed.servers : [];
  } catch {
    return [];
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const byId = new Map<string, ServerConfig>();
    for (const s of [...readServers(GLOBAL_CONFIG), ...readServers(projectConfig())]) byId.set(s.id, s); // project overrides global
    const servers = [...byId.values()].filter((s) => s.enabled !== false);
    if (servers.length === 0) return;

    for (const s of servers) {
      try {
        const client = new Client({ name: "piwork", version: "0.0.0" }, { capabilities: {} });
        let transport;
        if (s.transport === "http" && s.url) {
          transport = new StreamableHTTPClientTransport(new URL(s.url), s.headers ? { requestInit: { headers: s.headers } } : undefined);
        } else if (s.command) {
          transport = new StdioClientTransport({
            command: s.command,
            args: s.args ?? [],
            // Include the ambient env (PATH etc. for npx) plus the server's secrets.
            env: { ...(process.env as Record<string, string>), ...(s.env ?? {}) },
          });
        } else {
          ctx.ui.notify(`Connector "${s.id}": missing command/url`, "warning");
          continue;
        }

        await client.connect(transport);
        const { tools } = await client.listTools();
        for (const tool of tools) {
          const params = tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} };
          pi.registerTool({
            name: `${s.id}__${tool.name}`,
            label: `${s.label ?? s.id}: ${tool.name}`,
            description: tool.description ?? `${tool.name} (via ${s.label ?? s.id})`,
            parameters: params as never, // Pi accepts raw JSON Schema directly
            execute: async (_toolCallId, args) => {
              const result = (await client.callTool({ name: tool.name, arguments: (args ?? {}) as Record<string, unknown> })) as {
                content?: Array<{ type: string; text?: string }>;
                isError?: boolean;
              };
              if (result.isError) {
                const msg = (result.content ?? []).map((c) => c.text ?? "").join("\n");
                throw new Error(msg || `${tool.name} failed`);
              }
              return { content: (result.content ?? []) as never, details: result };
            },
          });
        }
        ctx.ui.notify(`Connector "${s.label ?? s.id}": ${tools.length} tool${tools.length === 1 ? "" : "s"} ready`, "info");
      } catch (err) {
        ctx.ui.notify(`Connector "${s.label ?? s.id}" failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }
  });
}
