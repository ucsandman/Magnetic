import { app, BrowserWindow } from 'electron'
import { writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createInterface } from 'readline'
import { IPC } from '../shared/channels'
import {
  buildCliArgs, childEnv, cliErrorMessage, ensureCopilotToolServer,
  parseStreamLine, resolveClaudeCli, setTurnTools, spawnCli, type CopilotToolDef
} from './copilot-cli'
import { forwardToolToRenderer } from './copilot-bridge'

/**
 * One subscription copilot turn = one headless `claude -p` child. The CLI
 * reaches the edit tools through the magnetic-mcp shim (copilot role), whose
 * port/token arrive via the per-turn MCP config. process.execPath +
 * ELECTRON_RUN_AS_NODE runs the shim without a separate Node install.
 */

const TURN_TIMEOUT_MS = 5 * 60_000
const activeTurns = new Map<string, { kill(): void }>()
/**
 * A cancel that arrives before the child is spawned/tracked (e.g. while
 * `resolveClaudeCli`/`ensureCopilotToolServer` are still resolving) would
 * otherwise be a silent no-op. `cancelCopilotCliTurn` records the id here
 * when there is no active entry to kill yet; `runCopilotCliTurn` consumes it
 * right after registering the child and kills immediately if present.
 */
const cancelledTurns = new Set<string>()

function shimPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'magnetic-mcp.mjs')
    : join(app.getAppPath(), 'scripts', 'magnetic-mcp.mjs')
}

export type CliTurnResult =
  | { ok: true; reply: string; sessionId: string | null }
  | { ok: false; message: string }

export async function runCopilotCliTurn(args: {
  turnId: string
  prompt: string
  resumeSessionId: string | null
  tools: CopilotToolDef[]
}): Promise<CliTurnResult> {
  const status = await resolveClaudeCli()
  if (!status.found || status.path === null) {
    cancelledTurns.delete(args.turnId)
    return {
      ok: false,
      message:
        'Claude Code is not installed — pick the API key provider, or install Claude Code and sign in.'
    }
  }
  const { port, token } = await ensureCopilotToolServer(forwardToolToRenderer)
  setTurnTools(args.tools)
  const configPath = join(app.getPath('temp'), `magnetic-copilot-${args.turnId}.json`)
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        magnetic: {
          command: process.execPath,
          args: [shimPath()],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            MAGNETIC_AGENT_PORT: String(port),
            MAGNETIC_AGENT_TOKEN: token,
            MAGNETIC_MCP_ROLE: 'copilot'
          }
        }
      }
    })
  )

  let stderrTail = ''
  let finalResult: { ok: boolean; reply: string; sessionId: string | null } | null = null
  let timeout: NodeJS.Timeout | undefined
  try {
    const child = spawnCli(
      status.path,
      buildCliArgs({ mcpConfigPath: configPath, resumeSessionId: args.resumeSessionId }),
      childEnv(process.env)
    )
    activeTurns.set(args.turnId, { kill: () => child.kill() })
    // A cancel that arrived before the child existed is stuck waiting in
    // cancelledTurns — honor it the moment we have something to kill.
    if (cancelledTurns.delete(args.turnId)) {
      child.kill()
    }
    child.stdin?.write(args.prompt)
    child.stdin?.end()

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000)
    })
    const window = BrowserWindow.getAllWindows()[0]
    if (child.stdout !== null) {
      createInterface({ input: child.stdout }).on('line', (line) => {
        const event = parseStreamLine(line)
        if (event.kind === 'delta') {
          if (window !== undefined && !window.isDestroyed()) {
            window.webContents.send(IPC.copilotCliDelta, { turnId: args.turnId, text: event.text })
          }
        } else if (event.kind === 'result') {
          finalResult = { ok: event.ok, reply: event.reply, sessionId: event.sessionId }
        }
      })
    }
    timeout = setTimeout(() => child.kill(), TURN_TIMEOUT_MS)
    const code = await new Promise<number | null>((resolve) => {
      child.on('error', () => resolve(-1))
      child.on('close', (exitCode) => resolve(exitCode))
    })
    const result = finalResult as { ok: boolean; reply: string; sessionId: string | null } | null
    if (result !== null && result.ok) {
      return { ok: true, reply: result.reply, sessionId: result.sessionId }
    }
    if (result !== null) {
      return {
        ok: false,
        message: result.reply !== '' ? result.reply : cliErrorMessage(code, stderrTail)
      }
    }
    return { ok: false, message: cliErrorMessage(code, stderrTail) }
  } finally {
    clearTimeout(timeout)
    activeTurns.delete(args.turnId)
    cancelledTurns.delete(args.turnId)
    try {
      rmSync(configPath)
    } catch {
      // best effort
    }
  }
}

/** PID-safe: kills the tracked child process object, never a process name. */
export function cancelCopilotCliTurn(turnId: string): void {
  const active = activeTurns.get(turnId)
  if (active !== undefined) {
    active.kill()
  } else {
    // No child tracked yet (still resolving CLI/tool-server) — stick the
    // cancel so runCopilotCliTurn kills it the instant it registers one.
    cancelledTurns.add(turnId)
  }
}
