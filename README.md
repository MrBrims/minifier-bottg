# Minifi Bot

[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Compose-blue.svg)](https://docs.docker.com/compose/)
[![Telegram](https://img.shields.io/badge/Telegram-Bot-26A5E4.svg)](https://core.telegram.org/bots)
[![License](https://img.shields.io/badge/License-ISC-yellow.svg)](https://opensource.org/licenses/ISC)
[![Version](https://img.shields.io/badge/Version-1.2.0-green.svg)](#changelog)

A Dockerized Telegram bot for image optimization and font conversion: raster images are minified and optionally converted to WebP, SVG and ICO files are minified in place, and TTF fonts are converted to WOFF2.

## Description

Minifi Bot is a Telegram frontend for the same processing pipeline as the Gulp-based minifier CLI: JPEG, PNG, GIF, and WebP go through sharp; SVG through SVGO; ICO stays ICO (icojs + sharp, no WebP); TTF becomes WOFF2 via `ttf2woff2`.

Each Telegram user has an isolated folder under `data/{userId}/`. After `/start`, the bot asks to upload images or fonts. Inline buttons appear according to what was uploaded. Results are sent as documents, or as a single ZIP if there are more than 2 files. After a successful send, sources and processed files for that job are deleted; leftover files expire after 10 minutes.

## Requirements

- Docker and Docker Compose
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

For local runs without Docker: Node.js 22 or higher and npm.

## Installation

### Quick Start (Docker)

1. Copy the environment file and set the token:
   ```bash
   cp .env.example .env
   ```
2. Put your token in `.env`:
   ```env
   BOT_TOKEN=123456:ABC-your-token
   ```
3. Build and start:
   ```bash
   make rebuild
   ```
   Or without Make: `docker compose up -d --build`.
4. Open the bot in Telegram and send `/start`.

Docker Compose wrappers (`make help` lists all targets):

```bash
make help      # list commands
make up        # start in background
make restart   # restart the container
make logs      # follow logs
make down      # stop and remove the container
```

User files persist in `./data` (mounted into the container as `/app/data`).

### Manual installation (Node.js)

1. Copy `.env.example` to `.env` and set `BOT_TOKEN`.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the bot:
   ```bash
   npm start
   ```

## Usage

### Start

Send `/start`. The bot replies: upload images or a font. Telegram compresses photos — send images as **files** (documents) when you need the original quality.

### Inline actions (after upload)

| Uploaded files | Buttons |
|----------------|---------|
| TTF | Convert to WOFF2 |
| Raster (JPEG, PNG, GIF, WebP), optionally mixed with SVG/ICO | Minify; Minify and convert to WebP |
| SVG and/or ICO only | Minify |

Processing:

- **Convert to WOFF2** — all source TTF → `fonts/dist/*.woff2`, then send the WOFF2 files
- **Minify** — SVG → `images/dist`; ICO and raster → `images/minific`; send minified copies (no WebP)
- **Minify and convert to WebP** — same minify step, then raster → WebP in `images/dist`; ICO stays ICO; send WebP, SVG, and ICO

A failed file is skipped; the rest of the batch still completes.

### File cleanup

- After results are sent, the bot deletes that job’s sources and outputs: minify/WebP clears `images/src`, `images/minific`, and `images/dist`; WOFF2 clears source `.ttf` files and `fonts/dist`.
- Files that were not downloaded (not sent) are deleted 10 minutes after they appear on disk (`mtime`). A background sweep runs about every 30 seconds and skips a user who is currently processing.
- Storage is the **current** size of `data/{userId}/`, not a lifetime total of processed files. If that folder exceeds 200 MB after an upload, the bot warns and shows an inline **Clear files** button that empties the user’s folder.

### File types

| Kind | Extensions | Pipeline |
|------|------------|----------|
| Raster | `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp` | Minify (same format); optional WebP |
| Vector | `.svg` | SVGO minify to `dist` |
| Icon | `.ico` | Minify, keep `.ico`, no WebP |
| Font | `.ttf` | WOFF2 |

## Configuration

Quality numbers live in `src/process/images.js` (same defaults as the CLI minifier):

| Setting | Default | Notes |
|---------|---------|--------|
| JPEG | quality 80, progressive, mozjpeg | Raster minify |
| PNG | quality 70, palette | Lossy-style compression similar to pngquant 60–80% |
| WebP | quality 80 | From minified rasters |
| ICO | PNG quality 70, palette | Frames recompressed; file stays `.ico` |
| SVG | SVGO `preset-default` | `removeViewBox` and `removeUselessStrokeAndFill` stay off |

Environment:

| Variable | Required | Notes |
|----------|----------|-------|
| `BOT_TOKEN` | yes | Telegram bot token; keep it in `.env` (gitignored) |
| `DATA_DIR` | no | Defaults to `./data`; Docker sets `/app/data` |

If more than 2 result files are produced, they are packed into `result.zip`.

## Project Structure

```
minifi-bot/
├── src/
│   ├── index.js              # Bot entry, /start command, file TTL sweep
│   ├── bot.js                # /start, uploads, inline actions, quota warning
│   ├── storage.js            # Per-user dirs, sizes, TTL purge, job/full cleanup
│   ├── classify.js           # raster / svg / ico / ttf
│   ├── send.js               # Send documents; ZIP if files > 2
│   └── process/
│       ├── images.js         # sharp, SVGO, icojs
│       └── fonts.js          # TTF → WOFF2
├── data/                     # Per-user files (gitignored, Docker volume)
├── Dockerfile
├── docker-compose.yml
├── Makefile                  # docker compose wrappers (make help)
├── .env.example
├── .env                      # BOT_TOKEN (gitignored)
├── package.json
└── README.md
```

## Troubleshooting

- **Bot does not start** — `BOT_TOKEN` is missing or invalid. Check `.env` and `docker compose logs`.
- **sharp install fails** — use the Docker image (prebuilt libvips). On a host install, you need a supported OS/CPU.
- **Photos look worse than expected** — Telegram compresses photos; send the file as a document.
- **Unsupported file** — only JPG, PNG, GIF, WebP, SVG, ICO, and TTF are accepted.
- **Outputs disappeared** — files are removed after a successful send, or 10 minutes after upload if they were never sent. The **Clear files** button empties the whole user folder when storage exceeds 200 MB.

## Changelog

### 1.2.0

- **NEW**: Limit each upload batch to 30 files; extra files in the same burst are not saved, with one warning

### 1.1.0

- **CHANGED**: Removed reply keyboard and `/delete_sources`, `/clear_images`, `/clear_fonts`
- **NEW**: Delete sources and processed files after a successful result send
- **NEW**: Expire undownloaded files 10 minutes after they appear on disk
- **NEW**: Warn when a user’s folder exceeds 200 MB and offer inline **Clear files**

### 1.0.0

- **NEW**: Telegram bot with `/start` prompt to upload images or fonts
- **NEW**: Inline actions — convert TTF to WOFF2; minify images; minify and convert raster to WebP
- **NEW**: Per-user storage under `data/{userId}/`
- **NEW**: Docker Compose image (`node:22-bookworm-slim`) with `./data` volume
- **NEW**: Results sent as documents; ZIP when more than 2 files
- **TECHNICAL**: Image pipeline matches the Gulp minifier — sharp, SVGO 4, icojs (ICO stays ICO)
- **TECHNICAL**: Font pipeline via `ttf2woff2`; grammY for Telegram

## License

ISC

## Support

Open an issue in this repository or contact the maintainer.
