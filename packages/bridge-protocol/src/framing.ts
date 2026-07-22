/**
 * Strict LF-only JSONL framing for the Piwork bridge.
 *
 * This mirrors Pi's own RPC framing rules (see the Pi docs, docs/rpc.md, and
 * dist/modes/rpc/jsonl.js), which we MUST match exactly because pi-host speaks Pi's
 * RPC protocol over the same stdio pipe:
 *
 *   - Records are delimited by LF ("\n") ONLY.
 *   - A trailing "\r" (from CRLF environments) is stripped from each record.
 *   - Payload strings may legally contain U+2028 / U+2029 and other Unicode
 *     separators, so we must NEVER use Node's `readline` (it also splits on those,
 *     which would corrupt records that contain them inside JSON strings).
 *
 * `createLineSplitter` is the pure, stream-agnostic core (easy to unit-test).
 * `attachJsonlLineReader` adapts it to a Node Readable stream.
 */
import type { Readable } from "node:stream";

/** Serialize one value as a strict JSONL record (single trailing LF). */
export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export interface LineSplitter {
  /** Feed a chunk; returns any complete lines it produced (CR-stripped). */
  push(chunk: string): string[];
  /** Flush any trailing partial line at end-of-stream. */
  end(): string[];
  /** Current buffered (incomplete) tail — for diagnostics/tests. */
  readonly buffered: string;
}

/** Pure LF-only line splitter. Handles arbitrary chunk boundaries. */
export function createLineSplitter(): LineSplitter {
  let buffer = "";
  const stripCr = (line: string) => (line.endsWith("\r") ? line.slice(0, -1) : line);
  return {
    push(chunk: string): string[] {
      buffer += chunk;
      const out: string[] = [];
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        out.push(stripCr(buffer.slice(0, nl)));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
      return out;
    },
    end(): string[] {
      if (buffer.length === 0) return [];
      const last = stripCr(buffer);
      buffer = "";
      return [last];
    },
    get buffered() {
      return buffer;
    },
  };
}

/**
 * Attach an LF-only JSONL reader to a Node Readable stream. Returns a detach fn.
 * `onLine` receives each complete, CR-stripped record (including a possible final
 * unterminated record at stream end).
 */
export function attachJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void {
  const splitter = createLineSplitter();
  stream.setEncoding("utf8");
  const onData = (chunk: string) => {
    for (const line of splitter.push(chunk)) onLine(line);
  };
  const onEnd = () => {
    for (const line of splitter.end()) onLine(line);
  };
  stream.on("data", onData);
  stream.on("end", onEnd);
  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}
