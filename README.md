# Reel List

A small cross-platform desktop app (Electron) for building and playing playlists of YouTube video links.

## Features

- Create, rename (✎ next to the title), and delete playlists
- Add videos by pasting a YouTube URL (title is auto-filled, but you can override it)
- Add local video files (mp4, mov, mkv, webm, etc.) from your computer via a native file picker
- Edit or delete any video, reorder with the up/down arrows
- Click any video to play it in the built-in player — YouTube links use the YouTube player, local files use a native video player, and you can mix both in the same playlist
- Set a preferred playback quality (144p–1080p, or Auto) at the bottom of the sidebar; it defaults to 360p and applies to all YouTube videos
- Prev / Play-Pause / Next transport controls
- Repeat modes per playlist, cycled with one button: **Off → All → One**
  - **Off** — playlist stops after the last video
  - **All** — loops back to the first video after the last one finishes
  - **One** — replays the current video on a loop
- Everything is saved automatically to a local JSON file (no account, no cloud)

## Requirements

- [Node.js](https://nodejs.org) 18 or newer

## Setup

```bash
cd playlist-app
npm install
npm start
```

This launches the app in development mode.

## Building an installer

```bash
npm run dist
```

This uses `electron-builder` to produce a distributable in the `dist/` folder:
- `.dmg` on macOS
- `.exe` (NSIS installer) on Windows
- `.AppImage` on Linux

Run this command on the target OS (or use electron-builder's cross-build options) to get the right installer for that platform.

## Where your data lives

Playlists are stored as JSON in Electron's per-OS app-data folder, e.g.:
- macOS: `~/Library/Application Support/Reel List/reel-list-data.json`
- Windows: `%APPDATA%\Reel List\reel-list-data.json`
- Linux: `~/.config/Reel List/reel-list-data.json`

## Notes

- Playback of YouTube links uses the official YouTube IFrame Player API, so an internet connection is required for those (same as visiting YouTube in a browser). Local files play back fully offline.
- Supported YouTube URL formats: `youtube.com/watch?v=...`, `youtu.be/...`, `youtube.com/embed/...`, `youtube.com/shorts/...`.
- Local videos are referenced by file path, not copied into the app — if you move or rename the original file, re-link it from the video's edit (✎) menu.
- The playback quality setting is sent to YouTube as a *request*, not a hard rule — YouTube's player is allowed to raise it automatically depending on your connection speed and the player size, especially in fullscreen. It's re-asserted on every load and state change, but YouTube has the final say for embedded playback.
- The app serves its own UI from `http://127.0.0.1` (a local server started on a random free port, only reachable from your own machine) instead of loading it as a `file://` page. This is required for YouTube's embedded player to work correctly in a desktop app — without it, YouTube playback fails with "Error 153: video player configuration error".
