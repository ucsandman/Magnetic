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
  const child = spawnCli(
    status.path,
    buildCliArgs({ mcpConfigPath: configPath, resumeSessionId: args.resumeSessionId }),
    childEnv(process.env)
  )
  activeTurns.set(args.turnId, { kill: () => child.kill() })
  child.stdin?.write(args.prompt)
  child.stdin?.end()

  let stderrTail = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000)
  })
  let finalResult: { ok: boolean; reply: string; sessionId: string | null } | null = null
  const window = BrowserWindow.getAllWindows()[0]
  if (child.stdout !== null) {
    createInterface({ input: child.stdout }).on('line', (line) => {
      const event = parseStreamLine(line)
      if (event.kind === 'delta') {
        window?.webContents.send(IPC.copilotCliDelta, { turnId: args.turnId, text: event.text })
      } else if (event.kind === 'result') {
        finalResult = { ok: event.ok, reply: event.reply, sessionId: event.sessionId }
      }
    })
  }
  const timeout = setTimeout(() => child.kill(), TURN_TIMEOUT_MS)
  const code = await new Promise<number | null>((resolve) => {
    child.on('error', () => resolve(-1))
    child.on('close', (exitCode) => resolve(exitCode))
  })
  clearTimeout(timeout)
  activeTurns.delete(args.turnId)
  try {
    rmSync(configPath)
  } catch {
    // best effort
  }
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
}

/** PID-safe: kills the tracked child process object, never a process name. */
export function cancelCopilotCliTurn(turnId: string): void {
  activeTurns.get(turnId)?.kill()
}
