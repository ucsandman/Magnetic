/**
 * Viewer fullscreen toggle (⛶ / Shift+F) via the renderer-side Fullscreen
 * API — no main-process window changes. A platform denial rejects the
 * promise; that is a documented no-op.
 */
export function toggleViewerFullscreen(): void {
  if (document.fullscreenElement !== null) {
    void document.exitFullscreen().catch(() => undefined)
    return
  }
  const panel = document.querySelector<HTMLElement>('[data-testid="panel-viewer"]')
  if (panel === null) return
  panel.requestFullscreen().catch(() => undefined)
}
