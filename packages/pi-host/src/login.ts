/**
 * OAuth login relay (pi-host "login" mode).
 *
 * The container has no browser and no reachable OAuth callback, so we don't do auth
 * here — Pi does (`ModelRuntime.login`). We only *relay* its interaction across the
 * container wall to the shell over a tiny JSONL protocol on stdio:
 *
 *   container → host:
 *     login_providers  {providers:[{id,name,usesCallbackServer}]}
 *     login_open_url    {url, instructions?}          (host opens a real browser)
 *     login_device_code {userCode, verificationUri, ...}
 *     login_progress    {message}
 *     login_prompt      {id, message, placeholder?, allowEmpty?}  (awaits login_input)
 *     login_select      {id, message, options:[{id,label}]}       (awaits login_input)
 *     login_done        {provider}
 *     login_error       {message}
 *   host → container:
 *     login_choose      {provider}
 *     login_input       {id, value}   (value "" = cancel for a select)
 *
 * The JSONL protocol above is STABLE — the shell's login UI depends on it. Only the
 * Pi-facing binding changes across Pi versions. In 0.84 Pi replaced `AuthStorage.login`'s
 * named callback bag with a single `AuthInteraction` = { notify(AuthEvent), prompt(AuthPrompt) };
 * this file maps that onto the JSONL messages above. See packages/pi-host/UPGRADING-PI.md.
 *
 * stdout is NOT taken over here (no runRpcMode), so we write JSONL directly. Keep
 * diagnostics on stderr.
 */
import { StringDecoder } from "node:string_decoder";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

type Json = Record<string, unknown>;

// Pi 0.84 auth interaction shapes (from @earendil-works/pi-ai auth/types). Declared
// structurally here so this file needs no direct pi-ai dependency — types are erased at
// runtime (Node type-stripping), and keeping them local documents exactly what we consume.
type AuthEvent =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };
type AuthPromptOption = { id: string; label: string; description?: string };
type AuthPrompt =
  | { type: "text"; message: string; placeholder?: string; signal?: AbortSignal }
  | { type: "secret"; message: string; placeholder?: string; signal?: AbortSignal }
  | { type: "select"; message: string; options: readonly AuthPromptOption[]; signal?: AbortSignal }
  | { type: "manual_code"; message: string; placeholder?: string; signal?: AbortSignal };
type AuthInteraction = { signal?: AbortSignal; notify(event: AuthEvent): void; prompt(prompt: AuthPrompt): Promise<string> };

// Minimal structural view of the providers ModelRuntime exposes (getProviders()).
type ProviderView = { id: string; name: string; auth?: { oauth?: { name?: string } | undefined } };

function emit(msg: Json): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

/** LF-only stdin reader (no readline; strips a trailing CR). */
function onStdinLines(onLine: (line: string) => void): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim()) onLine(line);
      nl = buffer.indexOf("\n");
    }
  });
}

// Sandbox-specific guidance for the manual code/redirect paste: the browser's redirect
// points inside the container and won't load, so the user pastes the URL back to us.
const MANUAL_CODE_MESSAGE =
  "After signing in, your browser will try to open a page that won't load (it points inside the sandbox). " +
  "Copy that page's FULL URL from the address bar and paste it here — or paste just the code.";

export async function runLogin(runtime: ModelRuntime, providerArg?: string): Promise<void> {
  console.error(`[pi-host:login] starting${providerArg ? ` provider=${providerArg}` : ""}`);

  const pending = new Map<string, (value: string) => void>();
  let chooseResolver: ((provider: string) => void) | undefined;
  let idc = 0;
  const nextId = () => `l${++idc}`;

  onStdinLines((line) => {
    let msg: Json;
    try {
      msg = JSON.parse(line) as Json;
    } catch {
      return;
    }
    if (msg.type === "login_choose" && typeof msg.provider === "string") {
      chooseResolver?.(msg.provider);
    } else if (msg.type === "login_input" && typeof msg.id === "string") {
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(typeof msg.value === "string" ? msg.value : "");
      }
    }
  });

  const ask = (request: Json): Promise<string> => {
    const id = nextId();
    return new Promise<string>((resolve) => {
      pending.set(id, resolve);
      emit({ ...request, id });
    });
  };

  // Advertise OAuth-capable providers. In 0.84 a provider offers OAuth login iff
  // `provider.auth.oauth` is present (mirrors interactive-mode's getLoginProviderOptions).
  const providers = (runtime.getProviders() as unknown as ProviderView[])
    .filter((p) => !!p.auth?.oauth)
    .map((p) => ({ id: p.id, name: p.auth?.oauth?.name ?? p.name }));
  const needChoice = !providerArg && providers.length > 1;
  emit({
    type: "login_providers",
    needChoice,
    // usesCallbackServer is vestigial in the shell (declared, never branched on); the
    // sandbox always relies on the manual redirect/code paste below.
    providers: providers.map((p) => ({ id: p.id, name: p.name, usesCallbackServer: false })),
  });

  if (providers.length === 0) {
    emit({ type: "login_error", message: "No OAuth providers are registered in this Pi build." });
    setTimeout(() => process.exit(1), 50);
    return;
  }

  // Resolve which provider to use.
  let providerId = providerArg;
  if (!providerId) {
    if (providers.length === 1) providerId = providers[0].id;
    else providerId = await new Promise<string>((resolve) => (chooseResolver = resolve));
  }
  console.error(`[pi-host:login] using provider ${providerId}`);

  // Map Pi's AuthInteraction onto the stable JSONL protocol above.
  const interaction: AuthInteraction = {
    notify: (event) => {
      switch (event.type) {
        case "auth_url":
          emit({ type: "login_open_url", url: event.url, instructions: event.instructions });
          break;
        case "device_code":
          emit({
            type: "login_device_code",
            userCode: event.userCode,
            verificationUri: event.verificationUri,
            intervalSeconds: event.intervalSeconds,
            expiresInSeconds: event.expiresInSeconds,
          });
          break;
        case "progress":
          emit({ type: "login_progress", message: event.message });
          break;
        case "info":
          emit({ type: "login_progress", message: event.message });
          break;
      }
    },
    prompt: async (prompt) => {
      if (prompt.type === "select") {
        // "" from login_input signals cancel; the AuthInteraction contract wants a reject.
        const value = await ask({ type: "login_select", message: prompt.message, options: prompt.options });
        if (value === "") throw new Error("Login cancelled");
        return value;
      }
      // text | secret | manual_code → a single-line prompt. Keep our sandbox paste guidance
      // for the manual_code step (the redirect won't load inside the container).
      const message = prompt.type === "manual_code" ? MANUAL_CODE_MESSAGE : prompt.message;
      const placeholder =
        prompt.type === "manual_code"
          ? "https://…/callback?code=…&state=…   (or the code)"
          : prompt.placeholder;
      return ask({ type: "login_prompt", message, placeholder, allowEmpty: false });
    },
  };

  try {
    await runtime.login(providerId, "oauth", interaction);
    emit({ type: "login_done", provider: providerId });
    console.error(`[pi-host:login] success`);
    // Give stdout a tick to flush before exit.
    setTimeout(() => process.exit(0), 50);
  } catch (err) {
    emit({ type: "login_error", message: err instanceof Error ? err.message : String(err) });
    console.error(`[pi-host:login] error:`, err);
    setTimeout(() => process.exit(1), 50);
  }
}
