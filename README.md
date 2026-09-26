# Nebula — Storage Intelligence

A cross-platform (macOS + Windows) desktop app that shows you exactly where your
disk space goes: an interactive storage treemap, byte-accurate duplicate
detection, and a largest-files explorer — wrapped in a dark, glassy dashboard.

## Features

- **Dashboard** — total size, file/folder counts, storage-by-type donut, top
  folders, largest files, and top extensions at a glance.
- **Storage Map** — a squarified treemap of any folder. Click to drill in,
  breadcrumbs to climb back out, with a sortable contents list beside it.
- **Duplicates** — three-pass detection: group by exact size → fingerprint the
  first 128 KB → confirm with a full streaming SHA-1 of the content (files over
  1.5 GB use a head/middle/tail sampled hash and are labeled "sampled match").
  Auto-select strategies: **Smart** (prefers organized locations and clean names,
  penalizes Downloads/temp folders and "copy of…"/"(1)" names), keep newest, or
  keep oldest. Removal goes to the Trash/Recycle Bin, never a permanent delete.
- **Instant reopen** — every completed scan is saved to a compressed index, so
  the next launch offers "Resume last session" and restores the full dashboard
  in moments without rescanning. Duplicate analyses are saved the same way,
  along with every content fingerprint, so a **second run only reads files that
  actually changed** (a 120k-file set re-analyzes in ~80 ms instead of
  re-hashing from scratch) and results can be restored after a restart.
- **Honest cleanup reporting** — after moving copies out of the way, Nebula shows
  what moved, what failed and why, and *where the files went*. Removed copies on
  an external drive go to a **`Nebula Trash` folder on that drive** (see below),
  on the startup disk to the normal Trash. Every move is verified against the
  filesystem; a failed move is never reported as a cleanup, and never removes
  files from the analysis.
- **Nebula Trash (drive-local, restorable)** — on any volume other than the
  startup disk, removed copies are moved into `<drive>/Nebula Trash/<session>/`,
  keeping each file's path relative to the drive. That folder is *visible in
  Finder*, browsable in the app (per session, with file counts and sizes),
  **restorable** to the exact original paths (an occupied path gets a
  collision-safe name instead of being overwritten), and **emptyable** with one
  confirmed action — which is what actually frees the space. This exists because
  a drive's own `.Trashes/<uid>` folder is invisible to Finder and unreadable to
  apps without Full Disk Access, so files moved there look like they vanished and
  the space stays used. Nebula never scans its own Trash folders, so removed
  copies can never reappear as duplicates — and Nebula refuses to scan that
  folder if you pick it, telling you how many files are waiting and pointing you
  at the Duplicates view instead. Anything already waiting (including leftovers
  in a drive's own `.Trashes` folder from before this feature) is reported on the
  dashboard, in the Duplicates view, and right after a scan, with the exact
  command to empty it if macOS blocks the app from doing so.
- **Similar Photos** — perceptual (dHash) fingerprinting clusters resized,
  re-exported, and lightly edited versions of the same shot, with thumbnails.
  Auto-select keeps the sharpest (highest-resolution) copy of each group.
- **Changes** — every rescan is diffed against the previous snapshot of the
  same folder: net change, biggest growing/shrinking folders, largest new and
  grown files, and what was deleted.
- **Compare** — content-match any two folders or drives (internal, external,
  or network): what's duplicated across both sides regardless of filename,
  what's unique to each — plus duplicates *within* each side — with per-side
  bulk selection to clear one copy.
- **Organize** — auto-tidy a messy folder (Downloads, Desktop…): screenshots,
  camera photos, installers, archives, documents and more are sorted into
  dedicated subfolders, optionally grouped by year. Full before/after preview
  with a checkbox on every file, nothing is overwritten, only top-level loose
  files are touched, and the whole operation is one-click undoable.
- **Largest Files** — top 150 by size with type filters, search, reveal, and
  trash actions.
- Works across all file types and sizes; symlinks are never followed (no cycles,
  no double-counting). Unreadable items are skipped and counted.

## Download

Grab the installer for your device from the
[latest release](https://github.com/deepirex/nebula/releases/latest):

| Your computer | File |
|---|---|
| Mac — Apple Silicon (M1/M2/M3/M4) | `…Mac-AppleSilicon.dmg` |
| Mac — Intel | `…Mac-Intel.dmg` |
| Windows 10/11 | `…Windows.exe` |

> **First launch on macOS**: the app isn't notarized with Apple, so after you drag
> it to Applications, macOS will claim it "is damaged and can't be opened". It
> isn't — that's the quarantine flag on unsigned downloads. Clear it once:
> `xattr -cr /Applications/Nebula.app`, then open Nebula normally.
> On **Windows**, if SmartScreen appears: **More info** → **Run anyway**.

## Tests

Headless engine tests (no window, real Electron APIs):

```bash
NEBULA_NO_WINDOW=1 ELECTRON_DISABLE_SANDBOX=1 npx electron test/smoke.js  /tmp/nebula-smoke
NEBULA_NO_WINDOW=1 ELECTRON_DISABLE_SANDBOX=1 npx electron test/state.js  /tmp/nebula-state
```

`smoke.js` covers scanning, similar photos, the changes diff, compare and
organize. `state.js` covers the persisted analysis + fingerprint cache (reuse,
invalidation, restore) and the Trash paths (verified moves, honest failures, the
drive-local Nebula Trash round-trip: move → restore → empty, scan exclusion, and
per-volume Trash reporting).

> macOS note: `test/state.js` moves a file to the Trash, which needs permission
> to write `~/.Trash`; run it outside any restricted sandbox.

## Run it

```bash
cd nebula
npm install
npm start
```

> macOS: to scan protected folders (Desktop/Documents/Photos), grant the app
> access when prompted — or give your terminal Full Disk Access in
> System Settings → Privacy & Security.

## Package installers

```bash
npm run dist   # uses electron-builder: .dmg on macOS, NSIS installer on Windows
```

Build for the platform you're on (macOS produces the dmg; run the same command
on a Windows machine — or in CI — for the .exe installer).

## Architecture

- `main.js` — Electron main process. Owns all scan data (a directory tree +
  flat file index), so the renderer stays light even for million-file scans.
  Concurrency-limited filesystem walker, streaming hash duplicate finder,
  trash/reveal/open file operations.
- `preload.js` — a minimal, context-isolated IPC bridge.
- `renderer/` — the UI. No frameworks, no network: hand-built donut chart,
  squarified treemap, and views in plain HTML/CSS/JS.
