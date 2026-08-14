import { spawn } from 'child_process'
import { app, BrowserWindow } from 'electron'
import { writeFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { createInterface } from 'readline'
import { IPC } from '../shared/channels'
import {
  buildCliArgs,
  childEnv,
  cliErrorMessage,
  ensureCopilotToolServer,
  parseStreamLine,
  resolveClaudeCli,
  setTurnTools,
  spawnCli,
  stopCopilotToolServer,
  type CopilotToolDef
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
/** How many turns are currently in flight — the tool server stops only when this hits 0. */
let activeTurnCount = 0

/**
 * `child.kill()` only signals the direct child. On Windows that direct child
 * is cmd.exe (for the `.cmd` shim) or the CLI itself; either way its own
 * children (the real CLI process, its stdout pipe) can survive the signal,
 * so `'close'` never fires and the turn promise hangs while the CLI keeps
 * running (and billing). `taskkill /T /F` kills the whole process tree by
 * PID — never by name, per the process-kill guard.
 */
function killTree(child: ReturnType<typeof spawn>): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']).on('error', () => {})
  } else {
    child.kill()
  }
}
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
  activeTurnCount += 1
  let configPath: string | null = null
  let cliCwd: string | null = null
  let stderrTail = ''
  let finalResult: { ok: boolean; reply: string; sessionId: string | null } | null = null
  let timeout: NodeJS.Timeout | undefined
  // Windows has no real signals: an externally-terminated process just reports
  // whatever exit code taskkill leaves it with, not null. Track that WE did
  // the killing (timeout, cancel) so a deliberate stop is always reported as
  // "stopped" rather than a confusing exit-code failure.
  let killedIntentionally = false
  try {
    const { port, token } = await ensureCopilotToolServer(forwardToolToRenderer)
    setTurnTools(args.tools)
    configPath = join(app.getPath('temp'), `magnetic-copilot-${args.turnId}.json`)
    // Carries the live bearer token — 0o600 is a no-op on Windows but matters
    // on mac/linux, matching the agent-sidecar precedent.
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
      }),
      { mode: 0o600 }
    )
    // Neutral cwd: the app's own cwd would let the user's project CLAUDE.md,
    // .claude settings/hooks, or an apiKeyHelper apply to this turn — including
    // one that bills an API key instead of the subscription. An empty per-turn
    // dir keeps the child's project context blank.
    cliCwd = join(app.getPath('temp'), `magnetic-copilot-cwd-${args.turnId}`)
    mkdirSync(cliCwd, { recursive: true })

    const child = spawnCli(
      status.path,
      buildCliArgs({ mcpConfigPath: configPath, resumeSessionId: args.resumeSessionId }),
      childEnv(process.env),
      cliCwd
    )
    activeTurns.set(args.turnId, {
      kill: () => {
        killedIntentionally = true
        killTree(child)
      }
    })
    // A cancel that arrived before the child existed is stuck waiting in
    // cancelledTurns — honor it the moment we have something to kill.
    if (cancelledTurns.delete(args.turnId)) {
      killedIntentionally = true
      killTree(child)
    }
    // Spawn-failure insurance: an unhandled 'error' on stdin (e.g. the child
    // never started) would otherwise crash main as an unhandled event.
    child.stdin?.on('error', () => {})
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
    timeout = setTimeout(() => {
      killedIntentionally = true
      killTree(child)
    }, TURN_TIMEOUT_MS)
    // A kill can leave the grandchild's stdout pipe open forever, so 'close'
    // (which waits for stdio to fully drain) never fires. Resolve on 'exit'
    // instead, with a short grace period for 'close' to let the last stdout
    // lines flush before we give up waiting for it.
    const code = await new Promise<number | null>((resolve) => {
      let settled = false
      const finish = (exitCode: number | null): void => {
        if (settled) return
        settled = true
        resolve(exitCode)
      }
      child.on('error', () => finish(-1))
      child.on('close', (exitCode) => finish(exitCode))
      child.on('exit', (exitCode) => {
        setTimeout(() => finish(exitCode), 500)
      })
    })
    // A kill we initiated should always read as "stopped", not as a random
    // exit-code failure — taskkill's forced-termination code isn't ours to
    // interpret (see killedIntentionally above).
    const effectiveCode = killedIntentionally ? null : code
    const result = finalResult as { ok: boolean; reply: string; sessionId: string | null } | null
    if (result !== null && result.ok) {
      return { ok: true, reply: result.reply, sessionId: result.sessionId }
    }
    if (result !== null) {
      return {
        ok: false,
        message: result.reply !== '' ? result.reply : cliErrorMessage(effectiveCode, stderrTail)
      }
    }
    return { ok: false, message: cliErrorMessage(effectiveCode, stderrTail) }
  } finally {
    clearTimeout(timeout)
    activeTurns.delete(args.turnId)
    cancelledTurns.delete(args.turnId)
    if (configPath !== null) {
      try {
        rmSync(configPath)
      } catch {
        // best effort
      }
    }
    if (cliCwd !== null) {
      try {
        rmSync(cliCwd, { recursive: true, force: true })
      } catch {
        // best effort
      }
    }
    activeTurnCount = Math.max(0, activeTurnCount - 1)
    if (activeTurnCount === 0) {
      // Idle: nothing left listening on the loopback port under a fixed
      // token forever. Stopping also rotates the token — ensureCopilotToolServer
      // mints a fresh one next turn, and the config is written per turn anyway.
      await stopCopilotToolServer()
    }
  }
}

/** PID-safe: kills the tracked child process tree, never a process name. */
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
