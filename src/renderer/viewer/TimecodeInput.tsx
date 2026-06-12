import { useEffect, useRef, useState, type ReactNode } from 'react'
import { parseTimecode, type Rational } from '../../shared/timecode'

/**
 * Click-to-edit transport timecode shared by the source and sequence viewers.
 * Click swaps the readout for an input; Enter parses (FCP right-to-left
 * fields) and seeks, Escape/blur cancels, invalid input rejects visibly and
 * stays open.
 */
export function TimecodeInput({
  display,
  fps,
  durationFlicks,
  onSeek,
  testId
}: {
  display: string
  fps: Rational
  durationFlicks: number
  onSeek(flicks: number): void
  testId: string
}): ReactNode {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [invalid, setInvalid] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  if (!editing) {
    return (
      <span
        className="viewer-tc viewer-tc-editable"
        data-testid={testId}
        title="Click to type a timecode"
        onClick={() => {
          setText(display)
          setInvalid(false)
          setEditing(true)
        }}
      >
        {display}
      </span>
    )
  }
  return (
    <input
      ref={inputRef}
      className={`viewer-tc viewer-tc-input${invalid ? ' is-invalid' : ''}`}
      data-testid="timecode-input"
      value={text}
      autoFocus
      spellCheck={false}
      onChange={(event) => {
        setText(event.target.value)
        setInvalid(false)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          const parsed = parseTimecode(text, fps)
          if (parsed === null) {
            setInvalid(true)
            return
          }
          onSeek(Math.min(parsed, durationFlicks))
          setEditing(false)
        } else if (event.key === 'Escape') {
          setEditing(false)
        }
      }}
      onBlur={() => setEditing(false)}
    />
  )
}
