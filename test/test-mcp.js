// Protocol-level tests for the MCP server. Runs outside VS Code: mcp.js
// deliberately has no `vscode` import, so the transport is testable on its own.
//   node test/test-mcp.js

const path = require("path");
const { createMcpServer, stopSpeaking } = require(path.join(__dirname, "..", "out", "mcp.js"));

const PORT = 51999;
const tools = [
  {
    name: "show_code",
    description: "test tool",
    inputSchema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] },
    run: async (args) => `revealed ${args.file} — quote test: it's "fine" \\ ok`,
  },
  {
    name: "boom",
    description: "always fails",
    inputSchema: { type: "object", properties: {} },
    run: async () => { throw new Error("file not found: nope.rs"); },
  },
];

const server = createMcpServer({ port: PORT, tools, onLog: () => {} });

async function rpc(payload) {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let failures = 0;
function check(label, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  -> " + detail}`);
  if (!cond) failures++;
}

(async () => {
  await new Promise((r) => server.once("listening", r));

  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  check("initialize returns serverInfo + tools capability",
    init.body?.result?.serverInfo?.name === "code-tutor" && !!init.body.result.capabilities.tools,
    JSON.stringify(init.body));
  check("initialize echoes protocol version",
    init.body?.result?.protocolVersion === "2025-06-18", JSON.stringify(init.body));

  const note = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  check("notification gets 202 with no body", note.status === 202 && note.body === null,
    `status=${note.status} body=${JSON.stringify(note.body)}`);

  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  check("tools/list returns both tools with schemas",
    list.body?.result?.tools?.length === 2 && list.body.result.tools[0].inputSchema.type === "object",
    JSON.stringify(list.body));

  const call = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "show_code", arguments: { file: "ch02_ownership/src/main.rs" } } });
  check("tools/call returns text content with tricky characters intact",
    call.body?.result?.content?.[0]?.text === `revealed ch02_ownership/src/main.rs — quote test: it's "fine" \\ ok`,
    JSON.stringify(call.body));

  const err = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "boom", arguments: {} } });
  check("tool failure comes back as isError text, not a transport error",
    err.body?.result?.isError === true && /nope\.rs/.test(err.body.result.content[0].text),
    JSON.stringify(err.body));

  const unknown = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "ghost", arguments: {} } });
  check("unknown tool is reported as isError", unknown.body?.result?.isError === true, JSON.stringify(unknown.body));

  const bad = await rpc({ jsonrpc: "2.0", id: 6, method: "nope/nope" });
  check("unknown method -> -32601", bad.body?.error?.code === -32601, JSON.stringify(bad.body));

  const ping = await rpc({ jsonrpc: "2.0", id: 7, method: "ping" });
  check("ping answers", ping.body?.result !== undefined, JSON.stringify(ping.body));

  const batch = await rpc([
    { jsonrpc: "2.0", id: 8, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 9, method: "ping" },
  ]);
  check("batch drops notifications and answers the rest",
    Array.isArray(batch.body) && batch.body.length === 2 && batch.body[1].id === 9,
    JSON.stringify(batch.body));

  const getRes = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: "GET" });
  check("GET (SSE attempt) -> 405 so client stays POST-only", getRes.status === 405, `status=${getRes.status}`);

  const raw = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json",
  });
  check("malformed body -> parse error", (await raw.json())?.error?.code === -32700, "no parse error");

  check("stopSpeaking is a no-op when nothing is speaking", stopSpeaking() === false, "returned true");

  server.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
