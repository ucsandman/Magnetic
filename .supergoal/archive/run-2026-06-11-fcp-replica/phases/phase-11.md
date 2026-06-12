SUPERGOAL_PHASE_START
Phase: 11 of 11 — Polish & Harden
Task: Every aspect verified — states, edges, security, a11y, perf, installer, docs, full regression + evidence suite
Type: greenfield, ui
Mandatory commands: npm run typecheck, npm run lint, npm test, npm run build, npm run test:e2e, npm run package
Acceptance criteria: 10
Evidence required: one paragraph per sub-pass, perf numbers, installer path + packaged boot proof, final screenshot set, final test summary
Depends on phases: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10

## Why

Catch what earlier phases missed because they were focused on shipping behavior. This is how "every aspect is perfect" gets enforced.

## Work

Run each sub-pass below; each produces a paragraph of evidence (checked / found / fixed) plus the listed artifacts.

1. **UX & copy** — sweep every visible string (menus, dialogs, toasts, empty states, tooltips): no debug text, no lorem, consistent casing (Title Case menus, sentence-case body). Fix in place.
2. **States** — empty library shows a friendly import CTA; import-in-progress shows job progress; **missing media**: on library open, assets whose file is gone get an alert badge + "Relink" dialog (file picker; relinks by new path if duration matches ±1 frame); unsupported codec shows the proxy/explanation message. Each E2E-verified (rename a fixture on disk for the relink test).
3. **Edges** — zero-length text selections, 500-clip timeline (generated) opens and scrubs interactively, unicode filename import (`日本語クリップ.mp4` fixture copy), library path with spaces. E2E or scripted proof for each.
4. **Security** — audit: contextIsolation on, nodeIntegration off, sandbox where possible; every IPC handler zod-validates (add a unit test that fires a malformed payload at each channel and expects rejection); CSP meta in index.html; no remote URLs loaded; `npm audit` reviewed (fix or justify highs).
5. **A11y** — tab/focus order through toolbar/inspector sane; every shortcut suppressed while typing in inputs (test); text contrast ≥ 4.5:1 against panel colors (list computed ratios for the 5 main text/bg pairs); shortcut overlay opened with `?` lists every binding (assert it enumerates the registry, not a hardcoded copy).
6. **Perf** — startup-to-interactive < 3 s (measured: app launch → first browser paint, E2E timestamp); timeline median frame < 33 ms at 500 clips; 5-minute playback soak: RSS growth < 25% (numbers in transcript).
7. **Packaging** — add electron-builder (NSIS target, app icon `build/icon.ico` — generate a simple magnet-glyph icon), `npm run package` → installer exe in `dist/`; launch the PACKAGED app and run the boot E2E against it (binaries: resources/bin shipped via extraResources; fetch-binaries documented as a first-run requirement OR bundled — pick bundled for the installer, note size).
8. **Docs** — README final: feature list (mirrors ROADMAP feature matrix), full shortcut table (generated from the registry), architecture sketch (kernel/compositor/main-process diagram in ASCII or mermaid), build/run/test/package steps, "design homage to Final Cut Pro" credit, known limitations (the OUT list).
9. **Diff review** — review the full tree for stray console.log/debugger, dead exports, leftover TODO/FIXME from this run; `bash .supergoal/repo-state.sh added-lines <baseline>` grep for `console.log|debugger|TODO|FIXME` must come back clean or each hit justified.
10. **Regression sweep** — full unit + E2E suite green in one run; final screenshot set: browser, viewer, timeline-with-edit, inspector, transcript panel, export dialog → `.supergoal/evidence/phase-11/`.

## Acceptance criteria (all must pass — verify each in transcript)

- Every visible string reviewed; zero debug placeholders remain (sub-pass 1 evidence paragraph)
- Empty-library CTA, import progress, missing-media relink flow, unsupported-codec message all E2E-verified
- 500-clip timeline interactive; unicode filenames and spaced paths work (proofs in transcript)
- Malformed-payload unit test exists for every IPC channel and passes; contextIsolation/nodeIntegration/CSP audit documented
- Shortcuts suppressed in text inputs; contrast ratios listed and ≥ 4.5:1; `?` overlay enumerates the live shortcut registry
- Startup < 3 s, 500-clip frame median < 33 ms, soak RSS growth < 25% (numbers in transcript)
- `npm run package` produces an NSIS installer in `dist/`; the packaged exe launches and passes the boot E2E
- README complete per sub-pass 8 (feature list, shortcut table, architecture, steps, credit, limitations)
- Added-lines cleanliness grep clean (or every hit explicitly justified in the evidence)
- Full test + E2E suite green in a single final run; final screenshot set saved

## Mandatory commands (run each, surface last ~10 lines + exit code)

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`
- `npm run test:e2e`
- `npm run package`

## Evidence required in transcript

- One paragraph per sub-pass (what was checked, found, fixed); perf numbers; installer path + packaged-app boot proof; final screenshot set in `.supergoal/evidence/phase-11/`; final test summary

## Notes

- electron-builder is a new dependency — pre-approved in ROADMAP assumptions.
- Packaged-app E2E: Playwright can launch an arbitrary executable path with `_electron.launch({ executablePath })`; binaries must resolve relative to `process.resourcesPath` when packaged — make the binary-path helper environment-aware NOW if it isn't already.
- Bundling ~250 MB of binaries makes a fat installer; acceptable for portfolio (note final size in evidence).
- Use the impeccable/polish design skills for sub-pass 1 sweeps if available; keep fixes surgical.
- This phase fixes, it does not refactor — behavior changes belong in earlier-phase fix specs if the audit reopens them.
