import { test } from "node:test";
import assert from "node:assert/strict";
import { createLineSplitter, serializeJsonLine } from "./framing.ts";
import { isExtensionUiRequest, isResponse, isAgentEvent, isBridgeHello, isBlockingUiRequest } from "./index.ts";

test("serializeJsonLine appends exactly one LF and no CR", () => {
  const s = serializeJsonLine({ a: 1 });
  assert.equal(s, '{"a":1}\n');
  assert.ok(!s.includes("\r"));
});

test("splits on LF only, one line per record", () => {
  const sp = createLineSplitter();
  assert.deepEqual(sp.push('{"a":1}\n{"b":2}\n'), ['{"a":1}', '{"b":2}']);
});

test("strips a trailing CR (CRLF tolerance) but keeps interior text", () => {
  const sp = createLineSplitter();
  assert.deepEqual(sp.push('{"x":"a\\tb"}\r\n'), ['{"x":"a\\tb"}']);
});

test("does NOT split on U+2028/U+2029 inside a JSON string", () => {
  // These are valid inside JSON strings; readline would wrongly split on them.
  const payload = { text: "line1 line2 end" };
  const line = JSON.stringify(payload); // contains raw U+2028/U+2029
  const sp = createLineSplitter();
  const lines = sp.push(line + "\n");
  assert.equal(lines.length, 1, "must be a single record");
  assert.deepEqual(JSON.parse(lines[0]), payload, "round-trips with separators intact");
});

test("handles chunk boundaries mid-record and mid-newline", () => {
  const sp = createLineSplitter();
  assert.deepEqual(sp.push('{"a"'), []);
  assert.deepEqual(sp.push(":1}"), []);
  assert.deepEqual(sp.push("\n{"), ['{"a":1}']);
  assert.deepEqual(sp.push('"b":2}\n'), ['{"b":2}']);
});

test("end() flushes an unterminated trailing record", () => {
  const sp = createLineSplitter();
  assert.deepEqual(sp.push('{"a":1}\n{"b":2}'), ['{"a":1}']);
  assert.deepEqual(sp.end(), ['{"b":2}']);
  assert.deepEqual(sp.end(), [], "end() is idempotent once drained");
});

test("empty input and lone newlines", () => {
  const sp = createLineSplitter();
  assert.deepEqual(sp.push(""), []);
  assert.deepEqual(sp.push("\n"), [""]);
  assert.deepEqual(sp.end(), []);
});

test("guards classify the message families", () => {
  assert.ok(isBridgeHello({ type: "piwork_hello", protocolVersion: 1, piVersion: "0.78.1", cwd: "/workspace" }));
  const sel = { type: "extension_ui_request", id: "1", method: "select", title: "t", options: ["a"] };
  assert.ok(isExtensionUiRequest(sel));
  assert.ok(isBlockingUiRequest(sel as any));
  assert.ok(!isBlockingUiRequest({ type: "extension_ui_request", id: "2", method: "notify", message: "x" } as any));
  assert.ok(isResponse({ type: "response", command: "prompt", success: true }));
  assert.ok(isAgentEvent({ type: "message_update" }));
  assert.ok(!isAgentEvent({ type: "response", command: "prompt", success: true }));
  assert.ok(!isAgentEvent({ type: "extension_ui_request", id: "1", method: "notify" }));
});
