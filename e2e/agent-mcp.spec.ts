import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createInterface, type Interface } from 'readline'

const ROOT = join(__dirname, '..')
const FFMPEG = join(ROOT, 'resources', 'bin', 'ffmpeg.exe')
// deterministic per-run test credential, injected via env — not a real secret
const TOKEN = ['not', 'a', 'secret', 'e2e', 'fixture', 'token'].join('-')
const SEC = 705_600_000

function launchApp(libraryPath: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      MAGNETIC_TEST: '1',
      MAGNETIC_AGENT: '1',
      MAGNETIC_AGENT_TOKEN: TOKEN,
      MAGNETIC_LIBRARY_PATH: libraryPath
    }
  })
}

/** Minimal MCP client over the REAL magnetic-mcp stdio bridge. */
class McpClient {
  private child: ChildProcess
  private lines: Interface
  private waiters = new Map<number, (message: Record<string, unknown>) => void>()
  private nextId = 1

  constructor(port: number) {
    this.child = spawn(process.execPath, [join(ROOT, 'scripts', 'magnetic-mcp.mjs')], {
      env: { ...process.env, MAGNETIC_AGENT_PORT: String(port), MAGNETIC_AGENT_TOKEN: TOKEN },
      stdio: ['pipe', 'pipe', 'inherit']
    })
    this.lines = createInterface({ input: this.child.stdout! })
    this.lines.on('line', (line) => {
      try {
        const message = JSON.parse(line) as Record<string, unknown>
        const waiter = this.waiters.get(message.id as number)
        if (waiter !== undefined) {
          this.waiters.delete(message.id as number)
          waiter(message)
        }
      } catch {
        // non-JSON noise
      }
    })
  }

  request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 30_000)
      this.waiters.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
    })
  }

  async callTool(name: string, args: unknown = {}): Promise<{ text: string; isError: boolean }> {
    const response = await this.request('tools/call', { name, arguments: args })
    const result = response.result as {
      content: { type: string; text: string }[]
      isError?: boolean
    }
    return { text: result.content[0]?.text ?? '', isError: result.isError === true }
  }

  close(): void {
    this.child.kill()
  }
}

test('phase 7: MCP bridge — perceive, propose, human accepts, toggle severs', async () => {
  test.setTimeout(300_000)
  const tempRoot = mkdtempSync(join(tmpdir(), 'magnetic-mcp-'))
  const fixture = join(tempRoot, 'session.mp4')
  execFileSync(FFMPEG, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=30:duration=10',
    '-f',
    'lavfi',
    '-i',
    "aevalsrc='0.4*sin(880*2*PI*t)':s=48000:d=10",
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    fixture
  ])
  const app = await launchApp(join(tempRoot, 'Mcp.mglib'))
  const page = await app.firstWindow()
  await page.evaluate((paths) => window.api.__test!.importPaths(paths), [fixture])
  await page.waitForFunction(() => {
    const hooked = window as unknown as { __magneticState?: () => { sequence: unknown } }
    return hooked.__magneticState !== undefined && hooked.__magneticState().sequence !== null
  })
  await page.getByTestId('asset-cell-session.mp4').click()
  await page.keyboard.press('e')

  const status = await page.evaluate(() => window.api.agentStatus())
  expect(status.running).toBe(true)
  expect(status.port).not.toBeNull()
  console.log(`sidecar on 127.0.0.1:${status.port}`)

  const client = new McpClient(status.port!)
  try {
    // ---- MCP handshake + tool inventory ----
    const init = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '0' }
    })
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe('magnetic-mcp')
    const list = await client.request('tools/list')
    const names = (list.result as { tools: { name: string }[] }).tools.map((tool) => tool.name)
    expect(names.sort()).toEqual(['check_flow', 'get_status', 'propose_edits', 'read_timeline'])

    // ---- perception: the external agent sees the real open sequence ----
    const timeline = await client.callTool('read_timeline')
    expect(timeline.isError).toBe(false)
    expect(timeline.text).toContain('session.mp4')
    expect(timeline.text).toContain('id=')
    console.log('external agent reads the real timeline')

    // ---- proposal: renders as a ghost diff, sequence untouched ----
    const durationOf = async (): Promise<number> => {
      const state = (await page.evaluate(() =>
        (
          window as unknown as {
            __magneticState(): { sequence: { spine: { durationFlicks: number }[] } }
          }
        ).__magneticState()
      )) as { sequence: { spine: { durationFlicks: number }[] } }
      return state.sequence.spine.reduce((sum, item) => sum + item.durationFlicks, 0)
    }
    const before = await durationOf()
    const proposal = await client.callTool('propose_edits', {
      ops: [{ name: 'ripple_delete_range', input: { from_sec: 4, to_sec: 6 } }]
    })
    expect(proposal.isError).toBe(false)
    expect(proposal.text).toContain('ghost-diff')
    await expect(page.getByTestId('agent-banner')).toBeVisible()
    expect(await durationOf()).toBe(before) // NOTHING applied yet

    const pending = await client.callTool('get_status')
    expect(JSON.parse(pending.text).proposalPending).toBe(true)

    // ---- the human accepts from the timeline banner ----
    await page.getByTestId('agent-banner-accept').click()
    expect(before - (await durationOf())).toBe(2 * SEC)
    const verdict = JSON.parse((await client.callTool('get_status')).text)
    expect(verdict.lastOutcome).toBe('accepted')
    expect(verdict.proposalPending).toBe(false)
    console.log('human accepted the external proposal; agent sees the verdict')

    // ---- flipping Agent Access off severs the connection instantly ----
    await page.evaluate(() => window.api.setSettings({ agentAccess: false }))
    const severed = await client.callTool('read_timeline')
    expect(severed.isError).toBe(true)
    console.log(`severed: ${severed.text}`)
  } finally {
    client.close()
  }
  await app.close()
})
