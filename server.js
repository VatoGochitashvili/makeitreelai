import "dotenv/config";
import express from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { makeClips, synthSpeech, probeVideoMeta } from "./src/pipeline.js";
import { authRouter, attachUser, getUsage, bumpVideoUsage } from "./src/auth.js";
import { schedulerRouter } from "./src/scheduler.js";
import { reelsRouter, addReels } from "./src/reels.js";
import { planOf, VOICE_IDS } from "./src/plans.js";
import { DATA_DIR } from "./src/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
// Serve the app. HTML/CSS/JS use "no-cache" so a fresh deploy is picked up
// immediately (the browser revalidates via ETag and gets a 304 when unchanged),
// while media/fonts can still be cached.
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    if (/\.(html|css|js|svg)$/.test(filePath)) res.setHeader("Cache-Control", "no-cache");
  },
}));

// accounts (register / login / logout / me / plan) — no billing yet
app.use(attachUser);
app.use("/api", authRouter);
app.use("/api", schedulerRouter);
app.use("/api", reelsRouter);

// finished clips are served from here
const CLIPS_DIR = path.join(__dirname, "public", "clips");
await fs.mkdir(CLIPS_DIR, { recursive: true });
app.use("/clips", express.static(CLIPS_DIR));

// cached narration voice samples
// YouTube cookies can be supplied as base64 (easiest on hosts with no disk):
// set YTDLP_COOKIES_B64 to the base64 of a cookies.txt exported from a
// logged-in browser. We decode it to a file and point yt-dlp at it.
if (process.env.YTDLP_COOKIES_B64 && !process.env.YTDLP_COOKIES) {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const cookieFile = path.join(DATA_DIR, "yt-cookies.txt");
    await fs.writeFile(cookieFile, Buffer.from(process.env.YTDLP_COOKIES_B64, "base64"));
    process.env.YTDLP_COOKIES = cookieFile;
    console.log("Loaded YouTube cookies from YTDLP_COOKIES_B64.");
  } catch (e) {
    console.warn("Could not write YTDLP_COOKIES_B64:", e.message);
  }
}

const SAMPLES_DIR = path.join(DATA_DIR, "voice-samples");
await fs.mkdir(SAMPLES_DIR, { recursive: true }).catch(() => {});

// in-memory job store (fine for MVP; swap for a DB later)
const jobs = new Map(); // id -> { logs:[], status, clips:[], error }

// Start a clipping job — requires login; enforces the user's plan limits.
app.post("/api/clip", async (req, res) => {
  const user = req.user;
  if (!user) return res.status(401).json({ error: "Please log in to generate clips." });

  const { url, voiceover: voiceoverReq, voice, caption, length, clips: clipsReq, range } = req.body || {};
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: "Please provide a valid video URL." });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "Server is missing OPENAI_API_KEY. Add it to your .env file." });
  }

  const plan = planOf(user.plan);

  // Monthly video cap (Free tier).
  const usage = getUsage(user);
  if (plan.videosPerMonth !== -1 && usage.videos >= plan.videosPerMonth) {
    return res.status(403).json({
      error: `You've used all ${plan.videosPerMonth} videos on the ${plan.name} plan this month. Upgrade for more.`,
      upgrade: true,
    });
  }

  // Voiceover is a paid-plan capability.
  const wantVoiceover = !!voiceoverReq;
  if (wantVoiceover && !plan.voiceover) {
    return res.status(403).json({
      error: `AI voiceovers are a Creator/Pro feature. Upgrade to enable them.`,
      upgrade: true,
    });
  }
  const chosenVoice = VOICE_IDS.has(voice) ? voice : "alloy";

  // Generation settings — validated, and never allowed past the plan's ceiling.
  const chosenClips = Math.min(
    plan.clipsPerVideo,
    Math.max(1, parseInt(clipsReq, 10) || plan.clipsPerVideo)
  );
  const chosenCaption = {
    style: ["bold", "highlight", "minimal", "none"].includes(caption?.style) ? caption.style : "bold",
    position: ["top", "center", "bottom"].includes(caption?.position) ? caption.position : "top",
    size: ["small", "medium", "large"].includes(caption?.size) ? caption.size : "medium",
  };
  const chosenLength = ["auto", "short", "medium", "long"].includes(length) ? length : "auto";

  // Optional [start, end] window — clips are only taken from this slice.
  let chosenRange = null;
  if (range && range.start != null && range.end != null) {
    const start = Math.max(0, Number(range.start));
    const end = Number(range.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 10) {
      return res.status(400).json({ error: "Pick a range of at least 10 seconds." });
    }
    chosenRange = { start, end };
  }

  // Count this run against the monthly quota up-front (cost control).
  bumpVideoUsage(user);

  const id = randomUUID();
  const job = { id, logs: [], status: "running", clips: [], error: null };
  jobs.set(id, job);
  res.json({ jobId: id });

  const log = (msg) => { job.logs.push({ t: Date.now(), msg }); };

  try {
    const { workDir, clips } = await makeClips(url, log, {
      maxClips: chosenClips,
      resolution: plan.resolution,
      voiceover: wantVoiceover,
      voice: chosenVoice,
      caption: chosenCaption,
      length: chosenLength,
      range: chosenRange,
    });
    // move clips into the public folder so the browser can play/download them
    const outDir = path.join(CLIPS_DIR, id);
    await fs.mkdir(outDir, { recursive: true });
    const published = [];
    for (const c of clips) {
      const name = path.basename(c.file);
      await fs.copyFile(c.file, path.join(outDir, name));
      published.push({
        url: `/clips/${id}/${name}`,
        title: c.title, hook: c.hook, virality: c.virality,
        start: c.start, end: c.end, narrated: !!c.narrated,
      });
    }
    job.clips = published;
    job.status = "done";
    // save this batch to the user's "My Reels" library
    addReels(user.id, published, url);
    // best-effort cleanup of the temp working dir
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  } catch (err) {
    job.status = "error";
    job.error = err.message;
  }
});

// Video preview: title, author, thumbnail and — crucially — duration, which
// the range selector needs. yt-dlp gives the real duration; oEmbed is the
// fallback (no duration, so the UI then just uses the whole video).
// Cached per URL so retyping doesn't re-run yt-dlp.
const previewCache = new Map();

app.get("/api/preview", async (req, res) => {
  const url = String(req.query.url || "");
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: "Invalid URL." });

  if (previewCache.has(url)) return res.json(previewCache.get(url));

  const cacheAndSend = (data) => {
    previewCache.set(url, data);
    if (previewCache.size > 200) previewCache.delete(previewCache.keys().next().value);
    res.json(data);
  };

  // Preferred: yt-dlp metadata (includes duration).
  try {
    const meta = await probeVideoMeta(url);
    if (meta && meta.title) return cacheAndSend(meta);
  } catch { /* fall through to oEmbed */ }

  // Fallback: YouTube oEmbed (title/author/thumbnail only).
  try {
    const r = await fetch(
      "https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(url),
      { signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return res.status(404).json({ error: "Preview unavailable." });
    const d = await r.json();
    cacheAndSend({
      title: d.title,
      author: d.author_name,
      thumbnail: d.thumbnail_url,
      duration: null,
    });
  } catch {
    res.status(404).json({ error: "Preview unavailable." });
  }
});

// Short spoken sample of a narration voice, so users can hear each one before
// generating. Cached per voice (in memory + on disk) so we only pay for the
// first request of each voice, ever.
const SAMPLE_TEXT = "Here's the moment that changes everything \u2014 this is how your clips will sound.";
const voiceSamples = new Map();

app.get("/api/voice-sample/:voice", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please log in." });
  const voice = req.params.voice;
  if (!VOICE_IDS.has(voice)) return res.status(400).json({ error: "Unknown voice." });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "Voice samples unavailable: server is missing OPENAI_API_KEY." });

  const send = (buf) => {
    res.set("Content-Type", "audio/mpeg");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(buf);
  };

  if (voiceSamples.has(voice)) return send(voiceSamples.get(voice));

  const cacheFile = path.join(SAMPLES_DIR, `${voice}.mp3`);
  try {
    const buf = await fs.readFile(cacheFile);
    voiceSamples.set(voice, buf);
    return send(buf);
  } catch { /* not cached yet — generate below */ }

  try {
    const buf = await synthSpeech(SAMPLE_TEXT, voice);
    voiceSamples.set(voice, buf);
    fs.writeFile(cacheFile, buf).catch(() => {}); // best-effort disk cache
    send(buf);
  } catch (err) {
    res.status(502).json({ error: "Could not generate a sample: " + err.message });
  }
});

// Poll job status + logs
app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  res.json({
    status: job.status,
    logs: job.logs,
    clips: job.clips,
    error: job.error,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MakeItReel running on http://localhost:${PORT}`));
