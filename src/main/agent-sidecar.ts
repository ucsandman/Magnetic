import { randomUUID } from 'crypto'
import { app, BrowserWindow } from 'electron'
import { writeFileSync, rmSync } from 'fs'
import { createServer, type Server } from 'http'
import { join } from 'path'
import type { Socket } from 'net'
import { IPC } from '../shared/channels'

/**
 * The agent door (structural clone of media-server.ts): a loopback HTTP
 * server external agent harnesses reach through the magnetic-mcp stdio
 * bridge. Every request needs the bearer token; every tool call is forwarded
 * to the RENDERER's agent gateway, where it runs against the same store —
 * external edits become pendingProposal ghost-diffs the human must Accept,
 * exactly like the in-app copilot. There is no live-write path and no export
 * surface here, by construction.
 *
 * Off by default. Starts when the Agent Access setting (or MAGNETIC_AGENT=1)
 * says so; flipping the setting off severs every connection immediately.
 */

export interface AgentSidecarStatus {
  running: boolean
  port: number | null
  token: string | null
}

let server: Server | null = null
let port: number | null = null
let token: string | null = null
const sockets = new Set<Socket>()
const pending = new Map<string, { resolve(value: unknown): void; timer: NodeJS.Timeout }>()

const RENDERER_TIMEOUT_MS = 30_000
const MAX_BODY_BYTES = 1_000_000

function discoveryPath(): string {
  return join(app.getPath('userData'), 'agent-sidecar.json')
}

/** Forward one tool call to the renderer gateway and await its reply. */
function callRenderer(tool: string, input: unknown): Promise<unknown> {
  const window = BrowserWindow.getAllWindows()[0]
  if (window === undefined) return Promise.reject(new Error('no editor window is open'))
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('the editor did not answer in time'))
    }, RENDERER_TIMEOUT_MS)
    pending.set(id, { resolve, timer })
    window.webContents.send(IPC.agentRequest, { id, tool, input })
  })
}

/** IPC.agentRespond handler target (wired in registerIpc). */
export function resolveAgentRequest(id: string, result: unknown): void {
  const entry = pending.get(id)
  if (entry === undefined) return
  pending.delete(id)
  clearTimeout(entry.timer)
  entry.resolve(result)
}

export function agentSidecarStatus(): AgentSidecarStatus {
  return { running: server !== null, port, token }
}

export async function startAgentSidecar(sharedToken: string): Promise<AgentSidecarStatus> {
  if (server !== null) return agentSidecarStatus()
  token = sharedToken
  const httpServer = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end(JSON.stringify({ error: 'bad token' }))
      return
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200).end(JSON.stringify({ ok: true }))
      return
    }
    if (req.method !== 'POST' || req.url !== '/tool') {
      res.writeHead(404).end(JSON.stringify({ error: 'unknown route' }))
      return
    }
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
      if (body.length > MAX_BODY_BYTES) req.destroy()
    })
    req.on('end', () => {
      void (async () => {
        try {
          const payload = JSON.parse(body) as { tool?: unknown; input?: unknown }
          if (typeof payload.tool !== 'string') throw new Error('missing tool name')
          const result = await callRenderer(payload.tool, payload.input)
          res.writeHead(200).end(JSON.stringify({ result }))
        } catch (error) {
          res
            .writeHead(400)
            .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      })()
    })
  })
  httpServer.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  server = httpServer
  const address = httpServer.address()
  port = typeof address === 'object' && address !== null ? address.port : null
  try {
    // discovery for the magnetic-mcp bridge (overridable via env on its side);
    // owner-only: the file carries the bearer token (mode is a no-op on
    // Windows, where %APPDATA% ACLs already scope it to the user)
    writeFileSync(discoveryPath(), JSON.stringify({ port, token }), { mode: 0o600 })
  } catch {
    // best-effort: the Settings panel still shows port + token for manual config
  }
  console.log(`agent sidecar listening on 127.0.0.1:${port}`)
  return agentSidecarStatus()
}

/** Toggle-off severs instantly: refuse new connections AND drop live ones. */
export async function stopAgentSidecar(): Promise<void> {
  if (server === null) return
  const closing = server
  server = null
  port = null
  token = null
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  for (const [, entry] of pending) clearTimeout(entry.timer)
  pending.clear()
  try {
    rmSync(discoveryPath())
  } catch {
    // already gone
  }
  await new Promise<void>((resolve) => closing.close(() => resolve()))
  console.log('agent sidecar stopped')
}
