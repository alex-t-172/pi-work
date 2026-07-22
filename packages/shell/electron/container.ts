/**
 * ContainerBridge — the Node-side of the Piwork bridge, deliberately independent of
 * Electron so it can be integration-tested headlessly (see container.test.ts).
 *
 * It runs the sandbox container (`docker run -i`), speaks Pi's RPC/JSONL protocol over
 * the piped stdio, and re-emits the three message families as typed events:
 *   - "hello"      : the piwork_hello handshake (first line)
 *   - "event"      : AgentSessionEvent passthrough (message_update, tool_*, agent_*, …)
 *   - "ui_request" : a serialized ctx.ui call (extension_ui_request)
 *   - "response"   : a reply to a command we sent
 * Plus lifecycle: "stderr", "exit", "error".
 *
 * Commands go the other way via send()/prompt()/steer()/… and respondUi().
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  attachJsonlLineReader,
  serializeJsonLine,
  isBridgeHello,
  isExtensionUiRequest,
  isResponse,
  type BridgeHello,
  type ExtensionUiRequest,
  type ExtensionUiResponse,
} from "@piwork/bridge-protocol";

export interface ContainerStartOptions {
  /** Host path to mount at /workspace (rw). */
  workspace: string;
  /** Container image tag. */
  image: string;
  /** Docker binary (default "docker"). */
  dockerBin?: string;
  /** Host dir bind-mounted at /root/.pi/agent. Mutually exclusive with agentVolume. */
  agentHostDir?: string;
  /** Named volume mounted at /root/.pi/agent (the production default). */
  agentVolume?: string;
  /** Add host.docker.internal:host-gateway (needed to reach a host-local model daemon). */
  addHostGateway?: boolean;
  /** Extra `docker run` args (before the image). */
  extraDockerArgs?: string[];
  /** Extra env passed with -e KEY (value taken from process env of docker). */
  passEnv?: string[];
  /** Explicit env vars set with -e KEY=VALUE (used for login mode, etc.). */
  env?: Record<string, string>;
}

type Handlers = {
  hello: (h: BridgeHello) => void;
  event: (e: Record<string, unknown>) => void;
  ui_request: (r: ExtensionUiRequest) => void;
  response: (r: { type: "response"; command: string; success: boolean; id?: string; data?: unknown; error?: string }) => void;
  stderr: (chunk: string) => void;
  exit: (code: number | null) => void;
  error: (err: Error) => void;
};

export class ContainerBridge extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private detach: (() => void) | undefined;

  on<K extends keyof Handlers>(event: K, listener: Handlers[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  emit<K extends keyof Handlers>(event: K, ...args: Parameters<Handlers[K]>): boolean {
    return super.emit(event, ...args);
  }

  start(opts: ContainerStartOptions): void {
    if (this.proc) throw new Error("ContainerBridge already started");
    const docker = opts.dockerBin ?? "docker";
    const args = ["run", "-i", "--rm"];
    if (opts.addHostGateway) args.push("--add-host=host.docker.internal:host-gateway");
    args.push("-v", `${opts.workspace}:/workspace`);
    if (opts.agentHostDir && opts.agentVolume) throw new Error("agentHostDir and agentVolume are mutually exclusive");
    if (opts.agentHostDir) args.push("-v", `${opts.agentHostDir}:/root/.pi/agent`);
    else if (opts.agentVolume) args.push("-v", `${opts.agentVolume}:/root/.pi/agent`);
    for (const key of opts.passEnv ?? []) args.push("-e", key);
    for (const [k, v] of Object.entries(opts.env ?? {})) args.push("-e", `${k}=${v}`);
    if (opts.extraDockerArgs) args.push(...opts.extraDockerArgs);
    args.push(opts.image);

    const proc = spawn(docker, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;

    proc.on("error", (err) => this.emit("error", err));
    proc.on("exit", (code) => this.emit("exit", code));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (c: string) => this.emit("stderr", c));

    this.detach = attachJsonlLineReader(proc.stdout, (line) => this.onLine(line));
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      // A non-JSON line means something wrote to the protocol channel — surface it
      // rather than silently dropping (this is how stdout-corruption bugs show up).
      this.emit("stderr", `[bridge] non-JSON stdout: ${line}\n`);
      return;
    }
    if (isBridgeHello(msg)) this.emit("hello", msg);
    else if (isExtensionUiRequest(msg)) this.emit("ui_request", msg);
    else if (isResponse(msg)) this.emit("response", msg);
    else this.emit("event", msg as Record<string, unknown>);
  }

  /** Send a raw command object (must be JSON-serializable, shaped as an RpcCommand). */
  send(command: Record<string, unknown>): void {
    if (!this.proc) throw new Error("ContainerBridge not started");
    this.proc.stdin.write(serializeJsonLine(command));
  }

  respondUi(response: ExtensionUiResponse): void {
    this.send(response as unknown as Record<string, unknown>);
  }

  // Convenience command wrappers ----------------------------------------------------
  prompt(message: string, opts?: { id?: string; streamingBehavior?: "steer" | "followUp" }): void {
    this.send({ id: opts?.id, type: "prompt", message, streamingBehavior: opts?.streamingBehavior });
  }
  steer(message: string, id?: string): void {
    this.send({ id, type: "steer", message });
  }
  followUp(message: string, id?: string): void {
    this.send({ id, type: "follow_up", message });
  }
  abort(id?: string): void {
    this.send({ id, type: "abort" });
  }
  getState(id = "get_state"): void {
    this.send({ id, type: "get_state" });
  }
  getAvailableModels(id = "get_available_models"): void {
    this.send({ id, type: "get_available_models" });
  }
  setModel(provider: string, modelId: string, id = "set_model"): void {
    this.send({ id, type: "set_model", provider, modelId });
  }

  /** Close stdin (triggers pi-host's clean shutdown) and hard-kill after a grace period. */
  async stop(graceMs = 4000): Promise<void> {
    const proc = this.proc;
    this.detach?.();
    if (!proc) return;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      proc.once("exit", done);
      try {
        proc.stdin.end();
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          proc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        resolve();
      }, graceMs);
    });
    this.proc = undefined;
  }
}
