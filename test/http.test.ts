import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import { startHttp } from '../src/server.js'
import { camera, fakeRing, makeCtx, tempVault, testConfig } from './helpers.js'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

async function rpc(port: number, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

describe('MCP over Streamable HTTP', () => {
  it('initializes, lists tools, calls list_cameras, and rejects foreign origins', async () => {
    const v = tempVault()
    cleanups.push(v.cleanup)
    const ring = fakeRing({ cameras: [camera('7', 'Front door'), camera('8', 'Back door', false)], videos: new Map(), searchCalls: [] })
    const ctx = makeCtx(testConfig(v.dir), ring)
    cleanups.push(() => ctx.ledger.close())
    const srv: http.Server = await startHttp(ctx, 0 as number)
    cleanups.push(() => new Promise((r) => srv.close(r)))
    const port = (srv.address() as { port: number }).port
    // port 0 means our Host allow-list was built for :0; rebuild with the real port
    srv.close()
    const real = await startHttp(ctx, port)
    cleanups.push(() => new Promise((r) => real.close(r)))

    const init = await rpc(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    })
    expect(init.status).toBe(200)
    expect(init.json.result.serverInfo.name).toBe('ring-recap')

    const list = await rpc(port, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const names = list.json.result.tools.map((t: { name: string }) => t.name)
    expect(names).toEqual(expect.arrayContaining(['list_cameras', 'sync_day', 'health']))

    const call = await rpc(port, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_cameras', arguments: {} } })
    const cams = JSON.parse(call.json.result.content[0].text)
    expect(cams.map((c: { name: string }) => c.name)).toEqual(['Back door', 'Front door'])
    expect(cams.find((c: { id: string }) => c.id === '8').online).toBe(false)

    const evil = await rpc(port, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }, { origin: 'https://evil.example' })
    expect(evil.status).toBe(403)
    // fetch() drops a custom Host header, so use node:http to simulate DNS rebinding
    const badHostStatus = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { host: 'attacker.test:8787' } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end('{}')
    })
    expect(badHostStatus).toBe(403)
  })
})
