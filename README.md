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
  in moments without rescanning.
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
