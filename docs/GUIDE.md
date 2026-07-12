# Magnetic User Guide

How to get the most out of Magnetic — from first launch to a finished export. Five minutes of reading covers 90% of the editor; the rest of this guide is for the power features.

> Keyboard-first is the fastest way to use Magnetic, just like the editor it pays homage to. Press `Shift+?` at any time to see every live shortcut.

---

## 1. Your first edit in five minutes

1. **Launch Magnetic.** A library is created at `C:\Users\<you>\Videos\Magnetic.mglib`. Everything auto-saves — there is no Save button.
2. **Import** — click **Import** (or File → Import Media…, or drag files into the browser). Clips are _copied_ into the library, so your originals are never touched. Cells show "processing…" while thumbnails generate in the background; you can keep working.
3. **Review a clip** — click a clip, then skim it by moving the mouse across its filmstrip. Double-click to open it in the Viewer. Use `L` to play (tap again for 2×), `K` to pause, `←`/`→` to step frames.
4. **Mark what you want** — press `I` where the good part starts and `O` where it ends. The marked range is what gets edited into the timeline.
5. **Build the spine** — press `E`. The marked range lands at the end of the timeline. Select the next clip, mark, `E` again. That is the whole core loop.
6. **Watch it** — click in the timeline, press `Home`, then `Space`.
7. **Export** — press `Ctrl+E`, pick 1080p, choose a destination, Export. Done.

Everything else below is refinement of those seven steps.

---

## 2. The library and importing

- A library is a folder bundle (`<name>.mglib`) holding `library.json`, your imported media, and generated caches. Copy the folder, and you've copied the whole project.
- Import always **copies** files into the library — delete or move the source files freely afterwards.
- On import, three background jobs run per clip: filmstrip thumbnails, audio waveform, and (if **Auto-transcribe** is checked in the sidebar) a speech transcript. The "processing…" shimmer disappears as each clip's jobs finish. If the app is closed mid-job, the work resumes on next launch.
- Formats: MP4/MOV/MKV/WebM/AVI video, WAV/MP3/M4A/AAC/FLAC audio. Codecs the system can't decode natively (e.g. ProRes) get a small **proxy** badge — playback transparently uses an H.264 preview proxy, and export still renders from the original.
- If a media file vanishes from disk you'll see **⚠ Relink** on the cell. Click it and pick a replacement — it must match the original duration within one frame, which protects your edit from silently changing length.

### Rating and finding clips

- Select a clip and mark it **favorite** or **rejected**; the dropdown above the grid filters by rating (`All Clips`, favorites, …).
- The search box filters by filename — and shortcuts are suspended while you type, so `e` types a letter instead of performing an edit.

---

## 3. The Viewer: review before you edit

Double-click any clip in the browser to open it — or just select it and press `Space` (or the ▶ button under the viewer): the clip opens and plays immediately. The bar under the picture has go-to-start, play/pause, frame-step, loop, and fullscreen buttons, so nothing requires the keyboard.

**Precision review:** click the timecode and type where you want to go (`1:02:12`, or just `500` for 5 s — digits fill in right-to-left, `Enter` seeks, `Esc` cancels). `Ctrl+L` (or 🔁) loops playback — with marks set, the loop wraps inside the marked range. `/` plays exactly the marked range and parks on the out point, so you can audition a selection before cutting it in. `Shift+F` (or ⛶) takes the viewer fullscreen for distraction-free review; `Esc` comes back.

**Compare takes side by side:** select two or more clips (`Shift`-click) and press the **Watch N** button in the browser toolbar. Up to 9 clips play at once in a grid — click a cell to hear its audio, click again to mute, and double-click the winner to open it in the viewer. `Esc` closes the grid.

| Key                   | Action                                                    |
| --------------------- | --------------------------------------------------------- |
| `Space`               | Play / pause                                              |
| `L`                   | Play forward — tap again to double speed                  |
| `J`                   | Play reverse — tap again to double speed                  |
| `K`                   | Pause                                                     |
| `←` / `→`             | Step exactly one frame (frame-accurate at any frame rate) |
| `Shift+←` / `Shift+→` | Step 10 frames                                            |
| `Home` / `End`        | Jump to the start / end of the clip                       |
| `I` / `O`             | Mark in / out                                             |
| `X`                   | Clear marks                                               |
| `/`                   | Play the marked range, pausing on the out point           |
| `Ctrl+L`              | Loop playback (loops the marked range when set)           |
| `Shift+F`             | Fullscreen viewer (`Esc` exits)                           |

**The marks matter:** when a clip has an in/out range marked, `E`/`W`/`Q`/`D` edit _that range_ into the timeline, not the whole clip. This is the single biggest workflow upgrade over drag-and-drop editing — review, mark, edit, never trim twice.

---

## 4. The magnetic timeline

The timeline has one **spine** (the primary storyline) plus **connected clips** that float above it on lanes. The magnetic rules:

- Clips on the spine are always butted together — no accidental gaps, no overlaps, ever.
- Deleting or trimming a clip **ripples**: everything downstream slides to close the gap.
- Connected clips stay attached to their spine parent — move the parent and they travel with it.
- If two connected clips would collide, the new one bumps up a lane instead of overlapping.

### The four edits

With a clip selected in the browser (and optionally marked in the viewer):

| Key | Edit          | What it does                                           | Use it for                               |
| --- | ------------- | ------------------------------------------------------ | ---------------------------------------- |
| `E` | **Append**    | Adds to the end of the spine                           | Building a rough cut in order            |
| `W` | **Insert**    | Splits at the playhead and pushes everything right     | Adding a missing shot mid-edit           |
| `Q` | **Connect**   | Attaches above the spine at the playhead               | Cutaways, B-roll, titles over a bite     |
| `D` | **Overwrite** | Replaces what's under the playhead, duration unchanged | Swapping a shot without rippling the cut |

You can also drag a clip from the browser straight onto the timeline.

### Getting around

- `Space` play/pause · `Home`/`End` jump to start/end · `↑`/`↓` jump between edit points · click the ruler to move the playhead. The sequence viewer has the same controls as buttons under the picture.
- `=` / `-` zoom in/out, `Shift+Z` zooms to fit the whole sequence. `S` toggles **skimming** (the preview follows your mouse across the timeline — great for hunting a moment, distracting when fine-trimming, so toggle it).
- Zoomed past one screen, a **minimap** strip appears along the bottom of the timeline: the whole sequence at a glance, with a rectangle marking what you're looking at. Click or drag in it to jump anywhere — essential on hour-long cuts. During playback the view pages along with the playhead automatically; the sequence viewer also shows a live **audio meter** while it plays.
- `N` toggles **snapping** — drags and trims click onto clip edges and the playhead. Turn it off for sub-frame nudging.
- Drag a clip's body to rearrange the spine; the other clips shuffle around it magnetically.

### Copy, paste, duplicate

- `Ctrl+C` copies the selected clips (spine and connected — effects, keyframes, and detached-audio flags ride along). `Ctrl+V` **insert-pastes** at the playhead; `Ctrl+Shift+V` pastes the clips **connected** above the spine at the playhead. Either paste is a single undo step.
- `Ctrl+D` duplicates the selection right after it — no clipboard round-trip needed.
- `Ctrl+Alt+V` is **Paste Attributes**: copy one clip, select another, and the copied clip's effects (transform, color, audio, keyframes) are applied to everything selected in one undo step. It does nothing if the clipboard is empty or holds more than one clip.
- All of these also live in the timeline's right-click menu. The clipboard is session-only, and text fields keep the normal system copy/paste.

---

## 5. Trimming

- **Select tool (`A`)** — the default. Drag a clip's _edge_ to ripple-trim it: the clip gets shorter/longer and everything downstream moves. Drag its _body_ to rearrange.
- **Blade (`B`)** — click anywhere on a clip to cut it. `Ctrl+B` blades at the playhead without switching tools (cuts the selected clips, or the clip under the playhead).
- **Trim tool (`T`)** — three trims in one, by where you grab:
  - clip **edge** → ripple (changes sequence length),
  - **edit point** between two clips → **roll** (moves the cut, total length unchanged),
  - clip **body** → **slip** (changes which part of the source plays, position and length unchanged).
- `Delete` ripple-deletes the selection; `Shift+Delete` **lifts** it, leaving a gap clip you can fill later.
- `Ctrl+Z` undoes anything — every edit, trim, transition, and transcript cut is one undo step. `Ctrl+Shift+Z` redoes.

> **Tip — leave handles.** Mark your in/out a second or two inside the clip's ends. Trims, rolls, slips, and especially transitions all need spare media ("handles") beyond the cut to work with.

### Detach audio, J-cuts and L-cuts

- **Right-click a spine clip → Detach Audio** (or `Ctrl+Shift+S` with it selected). The clip's audio moves into its own connected clip on the lane **below** the spine; the spine clip keeps the video and goes silent. The audio clip stays attached to its parent — move or rearrange the parent and it travels along.
- Once detached, drag the audio clip's **edges** to trim it independently of the video:
  - drag its **head** left past the parent's start and the audio leads the picture — a **J-cut** (you hear the next shot before you see it),
  - drag its **tail** so the audio runs short (or long) under the next shot — an **L-cut**.
- Trims clamp to the source media and the timeline start, so you can't drag past what exists. Detaching and each trim are single undo steps.
- Expected (and intentional): after detaching, trimming or slipping the **video** no longer moves the audio — that independence is the point. If you want them in lockstep again, undo the detach.

---

## 6. Transitions and titles

- Park the playhead near a cut and press `Ctrl+T` — a 1-second **cross dissolve** appears at the nearest edit point.
- **Right-click the transition badge** at the cut to cycle types: dissolve → wipe left → wipe right → fade-to-black.
- If `Ctrl+T` seems to do nothing, the clips at that cut have **no handles** — both sides need unused media beyond the cut (see the tip above). Trim each side in slightly, then retry.
- **Titles** live in the browser sidebar: double-click **Basic**, **Lower Third**, or **Bumper** to connect a 4-second title at the playhead. Select it and use the Inspector's **Title** tab to change text, font size, color, and position — the preview updates live.

---

## 7. The Inspector: transform, color, audio

Select a timeline clip and the Inspector (toggle with `Ctrl+4`) shows its tabs:

- **Video** — position, scale, rotation, opacity. Use scale + position for a quick picture-in-picture on a connected clip.
- **Color** — the color board: exposure, contrast, saturation, temperature. Subtlety wins: ±0.2 exposure or ±10 temperature is usually plenty.
- **Audio** — volume (dB), stereo pan, and **fade in / fade out** durations. A 0.2–0.5 s fade on every spoken clip removes clicks at the cuts.

Everything applies non-destructively and exports exactly as previewed.

### Keyframing: animate a parameter over time

Every Video and Color parameter can be animated with keyframes:

1. Park the playhead where the move should start and click the **diamond** (`◇`) next to the parameter — it fills (`◆`) and a keyframe is recorded at the playhead.
2. Move the playhead and **type a new value** — each edit writes another keyframe at the playhead. Two keyframes are all a Ken Burns push-in (Scale 100 → 120) or a fade-out (Opacity 100 → 0) needs.
3. Use `◀` / `▶` to hop the playhead between a parameter's keyframes; small white diamonds appear along the bottom edge of the clip in the timeline.
4. Click the filled diamond to remove the animation — the parameter freezes at whatever value it has right now.

Values ease smoothly between keyframes and hold steady before the first and after the last one. Keyframes ride the **source media**, so blading, trimming, or rearranging a clip never shifts the animation — only a _slip_ moves the media (keyframes included) under the clip. As with everything else, the animation previews live and exports exactly as shown.

---

## 8. Edit by transcript — the headline feature

Magnetic transcribes speech **locally** with whisper.cpp (nothing leaves your machine) and lets you edit video by editing text.

1. Leave **Auto-transcribe** checked (sidebar) so imports transcribe in the background — or right-click any clip with audio and choose transcribe.
2. Edit the talking clips into the timeline, then open the **Transcript** tab (top of the browser) or press `Ctrl+Shift+T`. The panel shows the transcript of _your timeline_, assembled in edit order.
3. **Click any word** — the playhead jumps to it. This is the fastest way to navigate an interview.
4. **Select a sentence and press `Delete`** — the corresponding video is ripple-deleted from the timeline, frame-accurately. One `Ctrl+Z` restores both the text and the video.
5. **Remove all fillers** — every _um_, _uh_, _like_, _you know_ is highlighted; one click cuts them all out of the video at once (and one undo brings them all back).
6. **Search** the transcript to find a phrase and jump straight to it.

Workflow that works: rough-cut the interview with `E`, then do your _content_ edit entirely in the transcript panel — cut the rambles as text — and only then fine-trim the cut points on the timeline.

### Remove silence — the dead-air cutter

The **Silence** tab (next to Transcript, top of the browser) finds every dead-air stretch in your timeline and cuts them all with one click:

1. Open the **Silence** tab. Magnetic analyzes each imported clip's loudness once, in the background — after that, retuning is instant.
2. Tune the detection: **Threshold** (how quiet counts as silent, default −34 dB), **Min duration** (ignore pauses shorter than this, default 0.5 s), **Padding** (breathing room kept on both sides of every cut, default 100 ms). Candidates appear live as red bands on the timeline; click a row to jump the playhead there, untick a row to keep that pause.
3. Click **Cut N gaps** — every gap is ripple-deleted at once, and a single `Ctrl+Z` brings them all back (same one-step undo as Remove fillers).

Detection is a loudness heuristic (50 ms RMS windows), so near fades you may want a lower threshold. Authored gaps you placed yourself are never detected — only quiet audio is.

### Rough Cut — the one-button first pass

The **Rough Cut** tab merges dead-air and filler-word detection into a single plan and applies it in one click — the first pass of a talking-head edit, done for you, with every cut reviewable:

1. Open the **Rough Cut** tab. One **Aggressiveness** slider replaces the three silence knobs (higher = shorter pauses count as dead air), and **Remove fillers** adds the transcript's um/uh/you-know ranges to the plan. Candidates preview live as red bands; each row says whether it's dead air or a filler, click a row to jump there, untick to keep it.
2. Click **Rough Cut** — nothing is applied yet. The proposal ghost-renders on the real timeline: red **hatched strikethrough** over everything that would go, and a green **PREVIEW strip** along the bottom showing the tightened result at the same time scale. Your timeline is never locked — keep editing if you want; any edit simply voids the proposal.
3. Click **Accept** to commit everything as ONE undo step (or **Discard** to drop it — the proposal never touches undo history, so discarding leaves zero trace).
4. Review spell-checker style: every cut gets a blue **AI** badge on the timeline ruler and a row in the list. Click a row to inspect that edit point; click **Reject** to restore just that cut — the others stay. One `Ctrl+Z` still reverts the whole pass.

The review window stays open until you edit something else or click **Done**; the AI badges are session-only provenance, never saved into the project. Every proposed sequence is checked against the timeline's legality invariants before it can be offered. Filler detection needs a transcript, so on freshly imported clips give transcription a moment to finish first.

### Copilot — ask questions about your cut

The **Copilot** tab is a read-only editing advisor: it can see the open sequence (clips and timing), the detected dead air, and the transcript — and nothing else. It cannot change the timeline.

1. First open asks for your Anthropic API key (get one at console.anthropic.com). It's stored in the app's settings on this machine, sent only to api.anthropic.com, and never logged. Change it later with the **Key…** button.
2. Ask about the cut in plain language: "what happens in the first 30 seconds?", "where does it drag?", "which takes mention the launch date?" Answers stream in with m:ss.s timecodes you can cross-check on the timeline.
3. Suggestions are advice, not actions — the copilot tells you *what* to cut and *where*; you (or the Rough Cut tab) do the cutting.

The copilot only knows what the panel headers know: if transcription hasn't finished, it will say so rather than guess.

### Burned-in captions — live from the transcript

Captions are never clips: they derive **live** from the transcript of your current cut, so every blade, trim, ripple, or transcript edit updates them instantly — there is nothing to re-sync, ever.

1. Open the **Captions** tab in the Inspector (it's there even with nothing selected — captions are a sequence-level setting) and tick **Enabled**.
2. Pick a style: **Pop-in** (words appear as they're spoken), **Karaoke** (full line with the current word highlighted), or **Block** (whole line at once). Font, size, color, highlight color, and position (bottom / middle / top) are all adjustable, and every change is one undo step.
3. The viewer shows captions immediately, and **export burns them in exactly as previewed** — same compositor, WYSIWYG by construction.

Cues are grouped automatically: a new caption starts after a pause longer than 0.6 s, when a line would exceed ~32 characters, or at every cut. Words that straddle a cut are dropped (same rule as the transcript panel), so trim to word boundaries — or edit in the transcript panel, which always cuts on them.

### Caption sidecar export (.srt / .vtt)

For platforms that want caption files instead of burned-in text, the Captions tab also exports sidecars:

- **Export SRT…** writes a numbered SubRip file (`HH:MM:SS,mmm`, CRLF) — accepted by YouTube, Premiere, Resolve, and most players.
- **Export VTT…** writes a WebVTT file (`HH:MM:SS.mmm`) for the web.
- Leave **Save to** empty to pick the destination in a save dialog, or type a path directly. The file reflects the cues of your _current_ cut at the moment you export.

---

## 9. Export

`Ctrl+E` opens the export dialog:

- **Presets**: 1080p, 720p, or source resolution — H.264/AAC MP4, plays everywhere.
- Progress is shown frame-by-frame and **Cancel** is safe: no partial file is ever left at the destination (the file only appears once the export completes).
- Export is WYSIWYG — transitions, titles, color, transforms, fades, and the audio mix render exactly as the preview showed, because it's the same compositor.
- **Smart render**: when the video track is one asset, possibly trimmed but visually untouched, the dialog shows _Smart render — video passthrough_ and copies the original H.264 bitstream instead of re-encoding it — a multi-hour VOD exports at roughly disk speed, and only the audio mix is rendered. Conditions: a single source clip (blade cuts that were never moved still count), no gaps, transitions, titles, or connected video, captions off, and every video/color adjustment at its default with no keyframes. Volume, fades, pan, detached audio, and connected music clips are fine — audio is always freshly mixed. The 720p preset needs scaling, so it always re-encodes. One caveat: the cut-in snaps to the nearest preceding keyframe of the source, so the export can start up to one GOP (typically ≤ a few seconds) before your exact in-point.

### Long recordings

Multi-hour captures (OBS sessions, podcasts, VODs) are a supported workload:

- **What scales**: preview video and audio stream in windows — a 6-hour clip plays without loading it into memory — and an untouched video track exports via smart render at disk speed instead of re-encoding every frame.
- **Music bed**: right-click a connected audio clip → **Loop to End of Spine** and it tiles its media to cover the whole timeline (a small tick marks each loop seam); fades apply across the whole bed, and **Unloop** trims it back into its source. Looped clips never appear in the transcript or silence panels — they're music, not speech.
- **Transcription**: clips longer than **30 minutes are skipped by auto-transcribe** (Whisper on a 6-hour file costs hours of CPU). Transcribe one manually whenever you want it: right-click the asset in the browser → **Transcribe**.
- **Disk note**: playback and export read audio from a PCM cache inside the library (`cache/`), about **700 MB per hour** of source audio. It's created on first play and safe to delete when a project wraps.

---

## 10. The shortcuts that matter most

The full table lives in the [README](../README.md#keyboard-shortcuts) and behind `Shift+?` in-app. The twenty worth memorizing:

`L` `K` `J` `Space` (transport) · `I` `O` `X` (marks) · `E` `W` `Q` `D` (edits) · `A` `B` `T` (tools) · `Delete` `Ctrl+B` `Ctrl+T` `Ctrl+Z` (surgery) · `Ctrl+C` `Ctrl+V` `Ctrl+D` `Ctrl+Alt+V` (clipboard) · `N` (snapping) · `Ctrl+E` (export)

---

## 11. Troubleshooting

| Symptom                                 | Cause / fix                                                                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Cell stuck on "processing…"             | Background jobs were interrupted — they resume automatically on relaunch. If a clip's media file is missing, relink it first.             |
| **proxy** badge on a clip               | The codec isn't natively decodable; playback uses an auto-generated H.264 preview. Export still uses the original file.                   |
| **⚠ Relink** badge                      | The media file moved or was deleted. Click the badge and select the file in its new location (duration must match ±1 frame).              |
| `Ctrl+T` adds no transition             | No handle media at that cut — trim both sides in slightly so the transition has frames to overlap.                                        |
| Keys do nothing                         | Focus is in a text field (search, inspector, title text) — shortcuts suspend while typing. Press `Escape` to return focus to the browser. |
| Panels squished or the wrong size       | Drag the dividers between panels to resize them, double-click a divider to reset that one, or press **Reset Layout** in the top bar.      |
| `J` doesn't play the timeline backwards | Reverse playback is viewer-only; in the timeline `J` pauses.                                                                              |
| 4K stutters                             | Expected at this stage — 1080p H.264 is the smooth path; 4K plays at degraded fidelity.                                                   |

---

## 12. Where things live

- **Library**: `C:\Users\<you>\Videos\Magnetic.mglib` (the app remembers the last library it opened)
- **Settings**: `%APPDATA%\Magnetic\settings.json`
- Back up or move a project by copying the `.mglib` folder — media, edits, and transcripts all travel together.
