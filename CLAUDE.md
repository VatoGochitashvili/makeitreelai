# MakeItReel — project context for Claude Code

## What this is
An AI tool that turns one long video (YouTube/podcast) into several ready-to-post vertical clips.
Competitor to Opus Clip. Target customer at launch: **podcasters** (then coaches, then faceless channels).
Business model: monthly subscription (~$19/mo). Planned differentiator vs Opus: an **auto-post scheduler**.

## Stack
- Node.js (ES modules) + Express
- OpenAI API — Whisper (transcription) + GPT (moment selection)
- `yt-dlp` (download) and `ffmpeg` (cut + vertical reframe + captions) — external CLI tools
- Vanilla HTML/CSS/JS frontend in `public/`

## Layout
- `server.js` — Express server; routes `POST /api/clip` (start job) and `GET /api/jobs/:id` (poll status/logs/clips). In-memory job store.
- `src/pipeline.js` — the pipeline: `makeClips(url, log)` → download → transcribe → selectMoments (GPT) → cutClip (ffmpeg). Returns clip files + metadata.
- `public/index.html` — the app UI: paste link, poll progress, render clip players + download.
- `.env` — needs `OPENAI_API_KEY` (copy from `.env.example`).

## How to run
```bash
cp .env.example .env      # add your OPENAI_API_KEY
npm install
npm start                 # http://localhost:3000
```
Requires `ffmpeg` and `yt-dlp` on PATH (macOS: `brew install ffmpeg yt-dlp`).

## Roadmap / good next tasks
1. **Animated word-by-word captions** — build an `.ass` subtitle file from Whisper word timestamps, burn with ffmpeg. Biggest quality win.
2. **Face-tracking reframe** — replace the center crop in `cutClip` with active-speaker detection so the crop follows the speaker.
3. **Accounts + Stripe** — login + $19/mo subscription, per-plan clip limits.
4. **Auto-post scheduler** — post finished clips to TikTok/IG/YouTube (the edge over Opus).
5. **Persist jobs** — move the in-memory `jobs` Map to a database.

## Conventions
- Keep the pipeline modular (one function per stage) so stages can be swapped.
- Never let users clip videos they don't own (add an ownership checkbox before launch).
- Cap clips per run via `MAX_CLIPS` to control API cost.
