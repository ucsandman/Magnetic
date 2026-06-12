# Magnetic — DESIGN.md

Register: **product** — the design serves the tool. FCP-style dark chrome; the
footage is the hero. Source of truth: `src/renderer/styles/global.css`
(tokens mirrored in `src/renderer/theme.ts`).

## Color

| Token | Hex | Role |
| --- | --- | --- |
| `--color-app-bg` | `#161617` | App background, input wells |
| `--color-panel-bg` | `#1d1d1f` | Panel surfaces, dialogs |
| `--color-panel-alt` | `#28282b` | Headers, buttons, raised chrome |
| `--color-border` | `#3a3a3c` | 1px hairline dividers, control borders |
| `--color-border-strong` | `#48484d` | Hover borders, menu border, scrollbar thumb |
| `--color-hover` | `#323236` | Button hover fill |
| `--color-pressed` | `#3a3a3e` | Button pressed fill |
| `--color-hover-overlay` | `rgb(255 255 255 / 8%)` | Row/word/tab hover on flat surfaces |
| `--color-accent` | `#0a84ff` | Apple dark-mode system blue: focus rings, timecode, selection borders |
| `--color-accent-fill` | `#0a6fe0` | Filled active/selected surfaces (4.8:1 with white text) |
| `--color-text` | `#f5f5f7` | Primary text |
| `--color-text-dim` | `#98989d` | Secondary text — 5.1:1 on panel-alt, 5.9:1 on panel-bg (AA) |
| `--color-danger` | `#ff6961` | Destructive menu items, media errors |

Accent discipline: blue means *selected/active/focus* only. Yellow `#ffd60a` =
marks/keyframes, green `#4ca47c` = audio waveforms, reds = destructive/errors.
No other color appears in the chrome. `color-scheme: dark` +
`accent-color: var(--color-accent)` keep every native widget (checkbox, range,
select popup, progress) in-theme.

## Type

- Family: `'Segoe UI', system-ui` (chrome) · `Consolas, monospace` (timecode, shortcut keys, silence rows)
- Scale: **11px** `--font-size-small` (toolbars, labels, fields) · **12px** `--font-size-base` (body, menus, timecode) · **13px** `--font-size-large` (app/dialog titles, weight 600)
- Panel/section headers: 11px, weight 500, uppercase, `letter-spacing: 0.02em`, dim color — one voice for `.panel-header`, `.sidebar-library`, `.inspector-section`
- All numeric readouts (timecode, durations, zoom, estimates) set `font-variant-numeric: tabular-nums`
- Micro-badges (proxy, missing, duration, mode) are 9px — intentional FCP density; never larger

## Spacing

4px base grid with 2px micro-steps: 2 / 4 / 6 / 8 / 10 / 12 / 16 / 32.
Fixed chrome heights: topbar **36px**, panel header **28px**, panel toolbar
**30px**, controls **20px** (`--control-height`), keyframe buttons 18px,
scrubber 14px. Panels separated by 1px `#000` gaps in the shell grid.

## Radii

| Token | Value | Used on |
| --- | --- | --- |
| `--radius-control` | 4px | Buttons, inputs, selects, kbd, menu rows |
| `--radius-menu` | 5px | Context menus, popovers (debug panel) |
| `--radius-dialog` | 8px | Modal dialogs (export, shortcuts) |

3px is reserved for sub-control chips (badges, transcript words, kf diamonds).

## Control states (every interactive element)

- **hover**: `--color-hover` fill + `--color-border-strong` border (buttons); `--color-hover-overlay` on flat rows/tabs/words
- **active (pressed)**: `--color-pressed`
- **selected/.active**: `--color-accent-fill` fill, accent border, white text — immune to hover washout
- **focus-visible**: 2px solid accent outline, 1px offset (never `outline: none`); focusable panel containers get a 1px inset `rgb(10 132 255 / 55%)` hairline instead
- **disabled**: `opacity: 0.45`, `cursor: default`, hover suppressed (`:hover:not(:disabled)` everywhere)
- **primary** (`button.primary`): accent-fill resting, full accent on hover — one per dialog/action bar (Export, Cut gaps)

## Menus & dialogs

Context menu: `#242427`, 1px `--color-border-strong` border, 5px radius,
layered shadow (`0 10px 28px / 55%` + `0 2px 8px / 35%`), 4px padding, rows
4×10px with accent-fill hover + white text, 1px hairline separators between
verb groups, danger items in `--color-danger`. Dialogs: 16px padding, title
13px/600, 10px body rhythm, right-aligned action row (primary last), backdrop
`rgb(0 0 0 / 55%)`, shadow `0 16px 48px / 55%`.

## Motion

One timing: `--transition-fast: 150ms ease-out`, applied to
background-color / border-color / color / opacity on hover, selection, and
expansion only. Layout properties never animate; no entrance choreography.
`@media (prefers-reduced-motion: reduce)` collapses all transitions and
animations (including the import shimmer).

## Scrollbars

WebKit overlay style: 12px gutter, 4px-inset pill thumb in
`--color-border-strong` (hover `#5a5a5f`), transparent track/corner.

## Empty states

Quiet and instructive: dim color, centered, `line-height: 1.5`, one sentence
telling the user the next action ("No media — File → Import Media… or drop
files here"). No illustration, no decoration.
