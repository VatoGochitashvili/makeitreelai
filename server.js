import "dotenv/config";
import express from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { makeClips } from "./src/pipeline.js";
import { authRouter, attachUser, getUsage, bumpVideoUsage } from "./src/auth.js";
import { schedulerRouter } from "./src/scheduler.js";
import { reelsRouter, addReels } from "./src/reels.js";
import { planOf, VOICE_IDS } from "./src/plans.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// accounts (register / login / logout / me / plan) — no billing yet
app.use(attachUser);
app.use("/api", authRouter);
app.use("/api", schedulerRouter);
app.use("/api", reelsRouter);

// finished clips are served from here
const CLIPS_DIR = path.join(__dirname, "public", "clips");
await fs.mkdir(CLIPS_DIR, { recursive: true });
app.use("/clips", express.static(CLIPS_DIR));

// in-memory job store (fine for MVP; swap for a DB later)
const jobs = new Map(); // id -> { logs:[], status, clips:[], error }

// Start a clipping job — requires login; enforces the user's plan limits.
app.post("/api/clip", async (req, res) => {
  const user = req.user;
  if (!user) return res.status(401).json({ error: "Please log in to generate clips." });

  const { url, voiceover: voiceoverReq, voice, caption, length, clips: clipsReq } = req.body || {};
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

// Video preview (title/author/thumbnail) via YouTube oEmbed — server-side so
// the browser doesn't hit CORS. Falls back to a bare thumbnail when unknown.
app.get("/api/preview", async (req, res) => {
  const url = String(req.query.url || "");
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: "Invalid URL." });
  try {
    const r = await fetch(
      "https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(url),
      { signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return res.status(404).json({ error: "Preview unavailable." });
    const d = await r.json();
    res.json({
      title: d.title,
      author: d.author_name,
      thumbnail: d.thumbnail_url,
      width: d.width,
      height: d.height,
    });
  } catch {
    res.status(404).json({ error: "Preview unavailable." });
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
