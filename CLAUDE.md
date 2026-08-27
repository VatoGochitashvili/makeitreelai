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
- `public/index.html`, `public/podcast.html`, `public/upload.html` — three
  single-purpose home pages (YouTube link / RSS feed / file upload). Same
  markup; `<body data-source>` picks which input shows.
- `public/studio.html` — the signed-in workspace: all three sources behind
  tabs, plus the plan strip and autopilot (`data-plan-meta="on"`).
- `public/tool.js` — the tool, shared by all four. Was duplicated inline in
  every page; don't copy it back.
- `src/backgrounds.js` — gameplay footage library for the split/brainrot formats.
- `.env` — needs `OPENAI_API_KEY` (copy from `.env.example`).

## How to run
```bash
cp .env.example .env      # add your OPENAI_API_KEY
npm install
npm start                 # http://localhost:3000
```
Requires `ffmpeg` and `yt-dlp` on PATH (macOS: `brew install ffmpeg yt-dlp`).

## Framing (why clips looked over-zoomed)
A full-bleed 9:16 crop of a 16:9 source keeps only ~32% of the width and
magnifies 1.78x. That's geometry, not a setting — the only way to zoom out is
to stop filling the frame edge to edge. Hence three `layout` options:
- `balanced` (default) — keeps ~48% of the width centred on the speaker, sized
  to fill ~66% of the frame height, blurred fill above and below. ~1.17x.
- `crop` — the old full-bleed behaviour. Tightest.
- `fit` — the whole frame, letterboxed. Smallest subject.

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

## Autopilot (the differentiator)
Opus hands you clips and stops. `src/autopilot.js` closes the loop: a creator
connects their podcast RSS once, and every new episode is clipped and queued to
post with nobody at the keyboard.

- polls each active feed every 30 min; newest unseen episode only, one per pass
- the first sync marks the back catalogue as seen, so connecting a feed doesn't
  spend a month's quota
- finished clips are spaced one per day at the user's chosen hour
- `startJob()` in `server.js` is the shared entry point — the route validates
  and replies, autopilot calls it directly with no req/res

Still simulated: actual publishing. `src/scheduler.js` flips due posts to
"posted" without calling TikTok/Instagram/YouTube. Those APIs need registered
apps, OAuth, and (for TikTok) an audit — start the applications early.

## Features pages
`public/features.html` is the index; `public/f/<slug>.html` is a page each.

The demo source in `public/demo-assets/` is ours end to end — our script, our
TTS, a picture drawn with ffmpeg — precisely so the outputs can be published
without using anyone else's footage. Everything on a Live feature's page came
out of a real pipeline run against it (`run.json` holds the actual moment picks
and model calls).

Soon features get a "Not built yet" panel and a schematic labelled as one. Do
not put a mocked-up artifact on a Soon page: the badge and the panel are the
only things standing between the marketing and a refund request.

To regenerate the assets, run the pipeline against `demo-assets/source.mp4`
with `layout: balanced` and `layout: crop` (the Smart Frame pair), plus
`format: split` and `format: brainrot`.

## Features page (menu + grid)
`public/features.html` lists all sixteen, each with a CSS-only animated demo of
the mechanism (`public/demos.css`). No JS, so a demo can't fail to start, and
they all stop under `prefers-reduced-motion`. The nav's Features menu links
here by anchor.

If you add a feature, it needs three things in step: an entry in the menu and
the on-page grid, a row on features.html, and a demo in demos.css.

## Feature naming
The nav's Features menu and the on-page grid share one source: the list is
generated, and every entry carries a Live or Soon badge. Six are Live (Moment
Finder, Gameplay Shorts, Kinetic Captions, Smart Frame, Voice Over, Autopilot);
ten are Soon and not built. Keep the badges honest — move one to Live only when
it actually ships, and say so in the same commit.

Names are deliberately ours, not Opus Clip's: Moment Finder (not ClipAnything),
Kinetic Captions, Smart Frame (not AI Reframe), Autopilot (not Social
scheduler), Cutaways (not AI B-Roll), Crew, Edit Room, Cover Art, Brand Kit,
Timeline Export, Reel API, Agent Bridge, Showcase, Director.

## Back catalogue miner (`src/catalogue.js`)
The thing no one-file-at-a-time tool can do. It transcribes a show's whole
history once, names the themes it keeps returning to, then finds the strongest
moments on a theme *across every episode* — "you've talked about burnout in
fourteen episodes, here are the six best answers".

- transcripts only, audio-only download: a 45-min episode is ~$0.27 and a few MB
- `/api/catalogue/quote` prices a scan before it runs; the UI shows the figure
  and asks. Never start a scan without that — a 100-episode catalogue is real money
- capped at 40 episodes per scan
- mining narrows by keyword first so only matching episodes reach the model
- a scan is an in-process loop, so a restart marks it interrupted and keeps what
  it already read

Why it matters commercially: it delivers value on day one from work the customer
already did, and it compounds — a competitor can't ship it as a feature because
they'd need the history.

## Roadmap / good next tasks
1. **Animated word-by-word captions** — build an `.ass` subtitle file from Whisper word timestamps, burn with ffmpeg. Biggest quality win.
2. **Face-tracking reframe** — `findSubjectX` is a motion-energy heuristic that
   picks one crop position per clip. Real active-speaker detection would let the
   frame follow someone as they move.
3. **Accounts + Stripe** — login + $19/mo subscription, per-plan clip limits.
4. **Real platform posting** — replace the simulated publisher in `src/scheduler.js`
   with TikTok/IG/YouTube API calls. This is what makes autopilot actually autopilot.
5. **Persist jobs** — move the in-memory `jobs` Map to a database.
6. **Job queue** — concurrent runs all render at once; nothing limits parallel
   ffmpeg/Whisper work per server.

Clip files are swept after `CLIP_RETENTION_DAYS` (default 30) — see
`sweepOldClips` in `src/reels.js`.

## Conventions
- Keep the pipeline modular (one function per stage) so stages can be swapped.
- Never let users clip videos they don't own (add an ownership checkbox before launch).
- Cap clips per run via `MAX_CLIPS` to control API cost.
