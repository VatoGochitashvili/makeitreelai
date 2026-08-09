# MakeItReel

Paste a long video link → get ready-to-post vertical clips. This is the working MVP: **download → transcribe → AI picks the best moments → cut vertical clips with title captions.**

## What's inside
```
makeitreel/
├── server.js            # Express server + API (/api/clip, /api/jobs/:id)
├── src/pipeline.js      # the actual clipping pipeline
├── public/index.html    # the app UI (paste link, watch progress, get clips)
├── package.json
├── .env.example         # copy to .env and add your OpenAI key
├── .replit / replit.nix # one-click run on Replit (installs ffmpeg + yt-dlp)
└── README.md
```

## The pipeline (src/pipeline.js)
1. **Download** the source video with `yt-dlp`.
2. **Transcribe** the audio with OpenAI Whisper (word/segment timestamps).
3. **Pick moments** — GPT reads the transcript and returns the best 15–60s segments with a title, hook, and virality score (1–100).
4. **Cut** each moment with `ffmpeg`, reframed to vertical 9:16 with a title caption burned on top.

## Run it on Replit (easiest)
1. Create a new Replit → "Import from folder" and upload this `makeitreel` folder (or push it to GitHub and import).
2. In Replit **Secrets** (the lock icon), add `OPENAI_API_KEY` = your key from https://platform.openai.com/api-keys
3. Press **Run**. Replit installs Node, ffmpeg and yt-dlp automatically (see `replit.nix`), then starts the server.
4. Open the web preview, paste a YouTube link you own, and click **Make my reels**.

## Run it locally
```bash
# needs: node 18+, ffmpeg, yt-dlp installed on your machine
cp .env.example .env      # then edit .env and add your OPENAI_API_KEY
npm install
npm start
# open http://localhost:3000
```
Install the tools if you don't have them:
- macOS: `brew install ffmpeg yt-dlp`
- Ubuntu: `sudo apt install ffmpeg` and `pip install yt-dlp`

## Cost per video (know this)
Every video hits the OpenAI API twice: Whisper (transcription) + GPT (moment selection). Roughly **$0.05–0.30 per typical video**. The `MAX_CLIPS` setting in `.env` caps clips per run so costs stay predictable.

## What this MVP does NOT do yet (your roadmap)
- **Animated word-by-word captions** — right now it burns a static title. Next upgrade: generate an `.ass` subtitle file from the Whisper word timestamps for karaoke-style captions (this is the #1 quality upgrade).
- **Smart face-tracking reframe** — currently a center crop. Upgrade to active-speaker detection so the crop follows the person.
- **User accounts + Stripe billing** — add login and the $19/mo subscription.
- **Auto-post scheduler** — post finished clips to TikTok/IG/YouTube (your planned edge over Opus).

## Notes
- Only clip videos **you own** — add a checkbox before launch to avoid copyright takedowns.
- Jobs are stored in memory (fine for testing). Move to a database before real users.
```
```
