# ERRORS.md — failures and lessons (newest first)

## 2026-08-14 — lint "clean" was a stale-cache illusion

- **Symptom:** `npm run lint` failed with ~13k `Delete ␍` prettier warnings across 42+ files, one day after the same command was verified clean at ship time.
- **Root cause:** two stacked causes. (1) `core.autocrlf=true` rewrites the worktree to CRLF on every checkout (the post-merge checkout of main did it here) while prettier defaulted to `endOfLine: lf`. (2) `eslint --cache` keys on file content and eslint config only — the prettier rc is not in the key — so cached "clean" results replayed until the cache went stale, and later cached *warnings* replayed even after the rc was fixed.
- **Fix:** `endOfLine: auto` in `.prettierrc.yaml` (`db57c73`); the git index stays LF via autocrlf. Cleared the cache and applied `eslint --fix` for 19 real wrap-format drifts the CRLF noise had hidden.
- **Lesson:** after changing any config a cached linter reads indirectly (prettier rc, tsconfig paths), delete the cache before trusting the next run. A green cached lint proves the cache, not the tree.
