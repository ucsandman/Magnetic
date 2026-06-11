import { useEffect, useState, type ReactNode } from 'react'
import type { DiagBinariesResult } from '../../shared/ipc'

/**
 * Hidden-by-default diagnostics overlay (Ctrl+Shift+D). Probes the bundled
 * native binaries through the diag:binaries IPC channel.
 */
export function DebugPanel(): ReactNode {
  const [result, setResult] = useState<DiagBinariesResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.api
      .diagBinaries()
      .then(setResult)
      .catch((err: unknown) => setError(String(err)))
  }, [])

  return (
    <div className="debug-panel" data-testid="debug-panel">
      <h2>Binary diagnostics</h2>
      {error !== null && <p data-testid="diag-error">{error}</p>}
      {result === null && error === null && <p data-testid="diag-pending">Probing binaries…</p>}
      {result !== null && (
        <table>
          <tbody>
            <tr>
              <th>ffprobe</th>
              <td data-testid="diag-ffprobe-code">{String(result.ffprobe.exitCode)}</td>
              <td>{result.ffprobe.firstLine}</td>
            </tr>
            <tr>
              <th>whisper</th>
              <td data-testid="diag-whisper-code">{String(result.whisper.exitCode)}</td>
              <td>{result.whisper.firstLine}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  )
}
