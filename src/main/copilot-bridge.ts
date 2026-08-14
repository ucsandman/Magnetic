import { randomUUID } from 'crypto'
import { BrowserWindow } from 'electron'
import { IPC } from '../shared/channels'
import type { ToolReply } from './copilot-cli'

/**
 * Forwards copilot tool calls from the loopback tool server to the renderer,
 * where they execute against the active turn's scratch sequence. Correlated
 * push/respond, 30s timeout — the sidecar pattern.
 */
const pendingToolCalls = new Map<
  string,
  { resolve(reply: ToolReply): void; timer: NodeJS.Timeout }
>()

export function forwardToolToRenderer(tool: string, input: unknown): Promise<ToolReply> {
  const window = BrowserWindow.getAllWindows()[0]
  if (window === undefined) {
    return Promise.resolve({ ok: false, content: 'no editor window is open' })
  }
  const id = randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingToolCalls.delete(id)
      resolve({ ok: false, content: 'the editor did not answer in time' })
    }, 30_000)
    pendingToolCalls.set(id, { resolve, timer })
    window.webContents.send(IPC.copilotToolRequest, { id, tool, input })
  })
}

export function resolveCopilotToolRequest(id: string, ok: boolean, content: unknown): void {
  const entry = pendingToolCalls.get(id)
  if (entry === undefined) return
  pendingToolCalls.delete(id)
  clearTimeout(entry.timer)
  entry.resolve({ ok, content })
}
