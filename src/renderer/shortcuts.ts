/**
 * Central keyboard shortcut registry. All phases register here so the
 * shortcut overlay (phase 11) can enumerate every binding. Events originating
 * in text inputs are ignored globally.
 */
export interface ShortcutDef {
  /** e.g. 'l', 'space', 'shift+arrowright', 'ctrl+shift+d' */
  combo: string
  description: string
  /** Optional gate, e.g. "viewer is focused". Defaults to always-on. */
  when?: () => boolean
  handler: (event: KeyboardEvent) => void
}

const registry = new Map<string, ShortcutDef>()
let installed = false

export function registerShortcut(id: string, def: ShortcutDef): () => void {
  registry.set(id, def)
  ensureInstalled()
  return () => {
    registry.delete(id)
  }
}

export function listShortcuts(): Array<{ id: string; combo: string; description: string }> {
  return Array.from(registry.entries(), ([id, def]) => ({
    id,
    combo: def.combo,
    description: def.description
  }))
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true
  return target instanceof HTMLElement && target.isContentEditable
}

function comboFromEvent(event: KeyboardEvent): string {
  const parts: string[] = []
  if (event.ctrlKey) parts.push('ctrl')
  if (event.altKey) parts.push('alt')
  if (event.shiftKey) parts.push('shift')
  if (event.metaKey) parts.push('meta')
  const key = event.key === ' ' ? 'space' : event.key.toLowerCase()
  if (!['control', 'alt', 'shift', 'meta'].includes(key)) parts.push(key)
  return parts.join('+')
}

function onKeyDown(event: KeyboardEvent): void {
  if (isEditableTarget(event.target)) return
  const combo = comboFromEvent(event)
  for (const def of registry.values()) {
    if (def.combo === combo && (def.when?.() ?? true)) {
      event.preventDefault()
      def.handler(event)
      return
    }
  }
}

function ensureInstalled(): void {
  if (installed) return
  installed = true
  window.addEventListener('keydown', onKeyDown)
}
