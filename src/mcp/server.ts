// In-process MCP server: runs inside the extension host (so tools call the repository sessions directly),
// served over Streamable HTTP bound to 127.0.0.1 and guarded by a bearer token. Local only.
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { LIST_REPOS, TOOLS, runTool, toolShape, type McpWorkspaceApi } from './tools';

export interface McpServerHandle {
  url: string; // where Claude Code connects (an "http" MCP server)
  port: number; // the actual bound port (for persisting an ephemeral one)
  token: string; // bearer token required on every request
  dispose(): void;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: true };

/** Run a tool body, turning a thrown error into an MCP error result the agent can read. */
async function answer(run: () => Promise<string> | string): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text' as const, text: await run() }] };
  } catch (e) {
    return { content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
  }
}

function buildServer(ws: McpWorkspaceApi, version: string): McpServer {
  const server = new McpServer({ name: 'reviewmate', version });
  server.registerTool(
    LIST_REPOS.name,
    { title: LIST_REPOS.title, description: LIST_REPOS.description, inputSchema: {} },
    () => answer(() => LIST_REPOS.handler(ws)),
  );
  for (const t of TOOLS) {
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: toolShape(t) }, (args) =>
      answer(() => runTool(ws, t, (args ?? {}) as Record<string, unknown>)),
    );
  }
  return server;
}

/** Start the MCP server on 127.0.0.1 (ephemeral port when `port` is 0), one MCP session per client. */
export async function startMcpServer(
  ws: McpWorkspaceApi,
  opts: {
    port: number;
    version: string;
    token: string;
    // A client reached the server with a missing or wrong token, most often a registration made for another
    // window or before the token changed.
    onUnauthorized?: () => void;
  },
): Promise<McpServerHandle> {
  const token = opts.token;
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.headers['authorization'] !== `Bearer ${token}`) {
      res.writeHead(401).end('Unauthorized');
      opts.onUnauthorized?.();
      return;
    }
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      if (req.method === 'POST' && isInitializeRequest(body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (sid) => {
            if (transport) transports.set(sid, transport);
          },
        });
        transport.onclose = () => {
          if (transport?.sessionId) transports.delete(transport.sessionId);
        };
        await buildServer(ws, opts.version).connect(transport);
      } else {
        res.writeHead(400, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'No valid session; send an initialize request first.' },
            id: null,
          }),
        );
        return;
      }
    }
    await transport.handleRequest(req, res, body);
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject); // e.g. EADDRINUSE — surfaces so the caller can fall back to an ephemeral port
    httpServer.listen(opts.port, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const addr = httpServer.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;
  return {
    url: `http://127.0.0.1:${actualPort}/mcp`,
    port: actualPort,
    token,
    dispose: () => {
      for (const t of transports.values()) void t.close();
      httpServer.close();
    },
  };
}

/** Read and JSON-parse the POST body (the transport is then handed the parsed value). */
function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    req.on('error', reject);
  });
}
