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

Double-click any clip in the browser to open it.

| Key                   | Action                                                    |
| --------------------- | --------------------------------------------------------- |
| `Space`               | Play / pause                                              |
| `L`                   | Play forward — tap again to double speed                  |
| `J`                   | Play reverse — tap again to double speed                  |
| `K`                   | Pause                                                     |
| `←` / `→`             | Step exactly one frame (frame-accurate at any frame rate) |
| `Shift+←` / `Shift+→` | Step 10 frames                                            |
| `I` / `O`             | Mark in / out                                             |
| `X`                   | Clear marks                                               |

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

- `Space` play/pause · `Home`/`End` jump to start/end · click the ruler to move the playhead.
- `=` / `-` zoom in/out. `S` toggles **skimming** (the preview follows your mouse across the timeline — great for hunting a moment, distracting when fine-trimming, so toggle it).
- `N` toggles **snapping** — drags and trims click onto clip edges and the playhead. Turn it off for sub-frame nudging.
- Drag a clip's body to rearrange the spine; the other clips shuffle around it magnetically.

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

---

## 9. Export

`Ctrl+E` opens the export dialog:

- **Presets**: 1080p, 720p, or source resolution — H.264/AAC MP4, plays everywhere.
- Progress is shown frame-by-frame and **Cancel** is safe: no partial file is ever left at the destination (the file only appears once the export completes).
- Export is WYSIWYG — transitions, titles, color, transforms, fades, and the audio mix render exactly as the preview showed, because it's the same compositor.

---

## 10. The shortcuts that matter most

The full table lives in the [README](../README.md#keyboard-shortcuts) and behind `Shift+?` in-app. The twenty worth memorizing:

`L` `K` `J` `Space` (transport) · `I` `O` `X` (marks) · `E` `W` `Q` `D` (edits) · `A` `B` `T` (tools) · `Delete` `Ctrl+B` `Ctrl+T` `Ctrl+Z` (surgery) · `N` (snapping) · `Ctrl+E` (export)

---

## 11. Troubleshooting

| Symptom                                 | Cause / fix                                                                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Cell stuck on "processing…"             | Background jobs were interrupted — they resume automatically on relaunch. If a clip's media file is missing, relink it first.             |
| **proxy** badge on a clip               | The codec isn't natively decodable; playback uses an auto-generated H.264 preview. Export still uses the original file.                   |
| **⚠ Relink** badge                      | The media file moved or was deleted. Click the badge and select the file in its new location (duration must match ±1 frame).              |
| `Ctrl+T` adds no transition             | No handle media at that cut — trim both sides in slightly so the transition has frames to overlap.                                        |
| Keys do nothing                         | Focus is in a text field (search, inspector, title text) — shortcuts suspend while typing. Press `Escape` to return focus to the browser. |
| `J` doesn't play the timeline backwards | Reverse playback is viewer-only; in the timeline `J` pauses.                                                                              |
| 4K stutters                             | Expected at this stage — 1080p H.264 is the smooth path; 4K plays at degraded fidelity.                                                   |

---

## 12. Where things live

- **Library**: `C:\Users\<you>\Videos\Magnetic.mglib` (the app remembers the last library it opened)
- **Settings**: `%APPDATA%\Magnetic\settings.json`
- Back up or move a project by copying the `.mglib` folder — media, edits, and transcripts all travel together.
