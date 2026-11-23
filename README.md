# Zantro

Zantro is a lightweight desktop media center built with Electron for organizing and watching local films and series (`.mp4`, `.mkv`, `.avi`, `.mov`, `.webm`, `.ts`).

## Features

- **Universal Local Playback** — Built-in FFmpeg live streaming engine for instant playback of `.mkv`, `.avi`, and `AC3`/`DTS` audio tracks without pre-conversion delays.
- **Automatic Metadata** — Automatically parses filenames and retrieves official posters, genres, localized synopses, and full cast with actor photos and biographies.
- **Clean Library Management** — Dedicated library manager separated from the cinema browsing view, supporting folder watching, individual files, and drag-and-drop.
- **Custom Video Player** — Resume playback, keyboard shortcuts (`Space`/`K`, `F`, `M`, `Left`/`Right`), playback speed (`0.5x`–`2x`), Picture-in-Picture, and auto-hiding controls.
- **Themes & Localization** — Dark, Light, and System Auto themes; available in English, French, and Spanish.

## Getting Started

### Download Installer (Windows)
Download `Zantro Setup 1.0.0.exe` from the [Releases](https://github.com/mdnzaa/zantro/releases) page.

### Run from Source
Requires [Node.js](https://nodejs.org/).

```bash
git clone https://github.com/mdnzaa/zantro.git
cd zantro
npm install
npm start