import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { AppContext } from './context.js'
import { registerResources } from './resources.js'
import { TOOLS } from './tools/index.js'
import type { ToolOutput } from './tools/types.js'
import { errMsg, log } from './util/log.js'
import { noEmDash } from './util/sanitize.js'

export const VERSION = '0.1.0'

const INSTRUCTIONS =
  'Daily recaps of the Ring cameras at one location. Call get_recap (no args) each morning for yesterday. ' +
  'Use search_events to find specific moments, get_clip_detail for one clip, health if something looks off.'

export function toMcpResult(out: ToolOutput): CallToolResult {
  const content: CallToolResult['content'] = []
  if (out.text !== undefined) content.push({ type: 'text', text: noEmDash(out.text) })
  else content.push({ type: 'text', text: JSON.stringify(out.json ?? null, null, 2) })
  if (out.image) content.push({ type: 'image', data: out.image.data, mimeType: out.image.mimeType })
  return { content }
}

export function buildServer(ctx: AppContext): McpServer {
  const server = new McpServer(
    { name: 'ring-recap', version: VERSION },
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  )
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly, openWorldHint: false },
      },
      async (args: unknown): Promise<CallToolResult> => {
        const started = Date.now()
        try {
          const out = await tool.handler(ctx, (args ?? {}) as never)
          log.info({ tool: tool.name, ms: Date.now() - started }, 'tool call')
          return toMcpResult(out)
        } catch (e) {
          log.warn({ tool: tool.name, err: errMsg(e) }, 'tool call failed')
          const code = (e as { code?: string }).code
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `${tool.name} failed${code ? ` (${code})` : ''}: ${errMsg(e)}` }],
          }
        }
      },
    )
  }
  registerResources(server, ctx)
  return server
}

export async function startStdio(ctx: AppContext): Promise<void> {
  const server = buildServer(ctx)
  await server.connect(new StdioServerTransport())
  log.info('MCP stdio server ready')
}

function readBody(req: http.IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('Request body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

/**
 * Stateless Streamable HTTP on 127.0.0.1 only. Host and Origin are checked on every request
 * so a web page cannot reach the server through DNS rebinding.
 */
export function startHttp(ctx: AppContext, port: number): Promise<http.Server> {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  const srv = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? ''
      const origin = req.headers.origin
      if (!allowedHosts.has(host) || (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))) {
        return sendJson(res, 403, { error: 'forbidden host or origin' })
      }
      const url = new URL(req.url ?? '/', `http://${host}`)
      if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, version: VERSION })
      if (url.pathname !== '/mcp') return sendJson(res, 404, { error: 'not found; MCP endpoint is /mcp' })
      if (req.method !== 'POST') {
        return sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: POST only)' }, id: null })
      }
      let body: unknown
      try {
        body = JSON.parse(await readBody(req))
      } catch (e) {
        return sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: `Parse error: ${errMsg(e)}` }, id: null })
      }
      const server = buildServer(ctx)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts: [...allowedHosts],
      })
      res.on('close', () => {
        transport.close().catch(() => {})
        server.close().catch(() => {})
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (e) {
      log.error({ err: errMsg(e) }, 'http request failed')
      if (!res.headersSent) sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
    }
  })
  return new Promise((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(port, '127.0.0.1', () => {
      log.info({ url: `http://127.0.0.1:${port}/mcp` }, 'MCP HTTP server ready')
      resolve(srv)
    })
  })
}
