/**
 * OAuth login relay (pi-host "login" mode).
 *
 * The container has no browser and no reachable OAuth callback, so we don't do auth
 * here — Pi does (`AuthStorage.login`). We only *relay* its callbacks across the
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
 * stdout is NOT taken over here (no runRpcMode), so we write JSONL directly. Keep
 * diagnostics on stderr.
 */
import { StringDecoder } from "node:string_decoder";
import type { AuthStorage } from "@earendil-works/pi-coding-agent";

type Json = Record<string, unknown>;

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

export async function runLogin(authStorage: AuthStorage, providerArg?: string): Promise<void> {
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

  // Advertise providers.
  const providers = authStorage.getOAuthProviders();
  const needChoice = !providerArg && providers.length > 1;
  emit({
    type: "login_providers",
    needChoice,
    providers: providers.map((p) => ({ id: p.id, name: p.name, usesCallbackServer: p.usesCallbackServer ?? false })),
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

  try {
    await authStorage.login(providerId, {
      onAuth: (info) => emit({ type: "login_open_url", url: info.url, instructions: info.instructions }),
      onDeviceCode: (info) =>
        emit({
          type: "login_device_code",
          userCode: info.userCode,
          verificationUri: info.verificationUri,
          intervalSeconds: info.intervalSeconds,
          expiresInSeconds: info.expiresInSeconds,
        }),
      onProgress: (message) => emit({ type: "login_progress", message }),
      onPrompt: (prompt) => ask({ type: "login_prompt", message: prompt.message, placeholder: prompt.placeholder, allowEmpty: prompt.allowEmpty }),
      onManualCodeInput: () =>
        ask({
          type: "login_prompt",
          message:
            "After signing in, your browser will try to open a page that won't load (it points inside the sandbox). " +
            "Copy that page's FULL URL from the address bar and paste it here — or paste just the code.",
          placeholder: "https://…/callback?code=…&state=…   (or the code)",
          allowEmpty: false,
        }),
      onSelect: async (prompt) => {
        const value = await ask({ type: "login_select", message: prompt.message, options: prompt.options });
        return value === "" ? undefined : value;
      },
    });
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
