import * as http from "http";
import { execFile, ChildProcess } from "child_process";

/**
 * A dependency-free MCP server (JSON-RPC 2.0 over streamable HTTP, POST only)
 * hosted inside the extension. Claude Code connects to it as a normal HTTP MCP
 * server, so the editor becomes something an agent can *drive*, not just read.
 */

const PROTOCOL_VERSION = "2025-06-18";

export interface ToolSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: ToolSchema;
  run(args: Record<string, unknown>): Promise<string>;
}

type JsonRpcId = string | number;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: { code: number; message: string };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

class RpcError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
  }
}

export interface McpServerOptions {
  port: number;
  tools: Tool[];
  onLog?: (line: string) => void;
}

export function createMcpServer(options: McpServerOptions): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" || req.method === "DELETE") {
      // No server-initiated stream and no sessions: this server is stateless.
      res.writeHead(req.method === "GET" ? 405 : 200).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 4e6) {
        req.destroy();
      }
    });

    req.on("end", () => {
      void handleBody(body, options, res);
    });
  });

  server.listen(options.port, "127.0.0.1");
  return server;
}

async function handleBody(
  body: string,
  options: McpServerOptions,
  res: http.ServerResponse
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }

  const isBatch = Array.isArray(parsed);
  const messages = (isBatch ? parsed : [parsed]) as JsonRpcMessage[];

  const replies: JsonRpcResponse[] = [];
  for (const message of messages) {
    const reply = await handle(message, options);
    if (reply) {
      replies.push(reply);
    }
  }

  if (replies.length === 0) {
    // Everything was a notification; nothing to answer.
    res.writeHead(202).end();
    return;
  }
  sendJson(res, 200, isBatch ? replies : replies[0]!);
}

async function handle(
  message: JsonRpcMessage,
  options: McpServerOptions
): Promise<JsonRpcResponse | null> {
  const { id, method, params } = message ?? {};
  const isNotification = id === undefined || id === null;

  try {
    const result = await dispatch(method, params, options, isNotification);
    if (result === SKIP || isNotification) {
      return null;
    }
    return { jsonrpc: "2.0", id: id as JsonRpcId, result };
  } catch (error) {
    const err = error as Error;
    options.onLog?.(`error in ${method}: ${err.message}`);
    if (isNotification) {
      return null;
    }
    // Tool failures come back as readable text so the agent can correct itself.
    if (method === "tools/call") {
      return {
        jsonrpc: "2.0",
        id: id as JsonRpcId,
        result: { content: [{ type: "text", text: err.message }], isError: true },
      };
    }
    return {
      jsonrpc: "2.0",
      id: id as JsonRpcId,
      error: {
        code: err instanceof RpcError ? err.code : -32603,
        message: err.message,
      },
    };
  }
}

const SKIP = Symbol("skip");

async function dispatch(
  method: string | undefined,
  params: Record<string, unknown> | undefined,
  options: McpServerOptions,
  isNotification: boolean
): Promise<unknown> {
  switch (method) {
    case "initialize": {
      const requested = params?.["protocolVersion"];
      return {
        protocolVersion:
          typeof requested === "string" ? requested : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "code-tutor", version: "0.2.0" },
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: options.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    case "tools/call": {
      const name = params?.["name"];
      const tool = options.tools.find((candidate) => candidate.name === name);
      if (!tool) {
        throw new RpcError(`Unknown tool: ${String(name)}`, -32602);
      }
      const args = (params?.["arguments"] as Record<string, unknown>) ?? {};
      const text = await tool.run(args);
      return { content: [{ type: "text", text: String(text) }] };
    }
    default:
      if (isNotification) {
        return SKIP;
      }
      throw new RpcError(`Method not found: ${String(method)}`, -32601);
  }
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown
): void {
  const data = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

// ---------------------------------------------------------------- speech

export interface SpeakOptions {
  text: string;
  voice: string;
  rate: number;
  wait: boolean;
}

let speaking: ChildProcess | null = null;

/** Speak text aloud, cancelling whatever was being said before. */
export function speak(options: SpeakOptions): Promise<string> {
  stopSpeaking();
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      "say",
      ["-v", options.voice, "-r", String(options.rate), "--", options.text],
      (error) => {
        speaking = null;
        if (error) {
          // A kill is an intentional interruption, not a failure.
          if ((error as NodeJS.ErrnoException & { killed?: boolean }).killed) {
            resolve("interrupted");
            return;
          }
          reject(error);
          return;
        }
        resolve("done");
      }
    );
    speaking = child;
    if (!options.wait) {
      resolve("speaking");
    }
  });
}

export function stopSpeaking(): boolean {
  if (speaking) {
    speaking.kill();
    speaking = null;
    return true;
  }
  return false;
}
