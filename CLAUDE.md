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
- `public/index.html` — the marketing home + the tool (logged-out visitors can preview).
- `public/studio.html` — the signed-in workspace; same tool, no pitch.
- `src/backgrounds.js` — gameplay footage library for the split/brainrot formats.
- `.env` — needs `OPENAI_API_KEY` (copy from `.env.example`).

## How to run
```bash
cp .env.example .env      # add your OPENAI_API_KEY
npm install
npm start                 # http://localhost:3000
```
Requires `ffmpeg` and `yt-dlp` on PATH (macOS: `brew install ffmpeg yt-dlp`).

## Output formats
`format` in the generate request picks how a clip is rendered:
- `clip` — the speaker, cropped to 9:16 (default)
- `split` — the clip on top, gameplay underneath, original audio
- `brainrot` — gameplay fills the frame, an AI voice reads a GPT-rewritten
  script, and the source video never appears

The last two need background footage, which we can't ship (it's someone's
copyright). Drop files in `assets/backgrounds/` for a shared library, or let
users upload their own from the Studio — see `src/backgrounds.js`.

Captioning narration works by sending the TTS audio back through Whisper: we
know the words but not their timing, and a clean synthetic voice transcribes
almost exactly.

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
