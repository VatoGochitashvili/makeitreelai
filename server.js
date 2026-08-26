import "dotenv/config";
import express from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { makeClips, synthSpeech, probeVideoMeta, probeDurationSec, withAiLogger, withJob, Cancelled } from "./src/pipeline.js";
import { createWriteStream } from "node:fs";
import { authRouter, attachUser, getUsage, bumpVideoUsage, refundVideoUsage } from "./src/auth.js";
import { schedulerRouter } from "./src/scheduler.js";
import { reelsRouter, addReels } from "./src/reels.js";
import { planOf, VOICE_IDS } from "./src/plans.js";
import { DATA_DIR } from "./src/store.js";
import { fetchPodcastFeed, normalizeUrl, isDirectMedia } from "./src/sources.js";
import { workerRouter, workerEnabled, requestDownload, workerOnline } from "./src/worker-queue.js";

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
app.use("/api", workerRouter);

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

// ---------- direct file upload ----------
// The reliable path: the user hands us their own video, so no third party can
// block us. Raw bytes are streamed straight to disk (no multipart dependency).
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
await fs.mkdir(UPLOAD_DIR, { recursive: true }).catch(() => {});

const uploads = new Map(); // uploadId -> { userId, file, name, size, duration, at }
const ALLOWED_VIDEO = /\.(mp4|mov|m4v|webm|mkv|avi|mp3|m4a|wav)$/i;

app.post("/api/upload", async (req, res) => {
  const user = req.user;
  if (!user) return res.status(401).json({ error: "Please log in to upload." });

  const plan = planOf(user.plan);
  const maxBytes = plan.maxUploadMB * 1024 * 1024;
  const declared = Number(req.headers["content-length"] || 0);
  if (declared && declared > maxBytes) {
    return res.status(413).json({
      error: `That file is larger than your ${plan.name} plan's ${plan.maxUploadMB} MB limit.`,
      upgrade: true,
    });
  }

  const name = String(req.query.name || "video.mp4").replace(/[^\w.\- ]/g, "_").slice(-80);
  if (!ALLOWED_VIDEO.test(name)) {
    return res.status(400).json({ error: "Unsupported file type. Use mp4, mov, webm, mkv, mp3 or wav." });
  }

  const id = randomUUID();
  const ext = (name.match(ALLOWED_VIDEO) || [".mp4"])[0];
  const file = path.join(UPLOAD_DIR, id + ext);
  const out = createWriteStream(file);

  let written = 0, aborted = false;
  const fail = async (code, msg) => {
    if (aborted) return;
    aborted = true;
    req.unpipe(out); out.destroy();
    await fs.rm(file, { force: true }).catch(() => {});
    if (!res.headersSent) res.status(code).json({ error: msg });
  };

  req.on("data", (chunk) => {
    written += chunk.length;
    if (written > maxBytes) fail(413, `Upload exceeds your ${plan.name} plan's ${plan.maxUploadMB} MB limit.`);
  });
  req.on("aborted", () => fail(499, "Upload cancelled."));
  out.on("error", () => fail(500, "Could not save the upload."));

  req.pipe(out);

  out.on("finish", async () => {
    if (aborted) return;
    if (!written) return fail(400, "The upload was empty.");
    let duration = null;
    try { duration = await probeDurationSec(file); } catch { /* unknown duration */ }
    uploads.set(id, { userId: user.id, file, name, size: written, duration, at: Date.now() });
    res.json({ uploadId: id, name, size: written, duration });
  });
});

// Drop uploads older than 6 hours so disks don't fill up.
const uploadSweep = setInterval(async () => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [id, u] of uploads) {
    if (u.at < cutoff) {
      uploads.delete(id);
      await fs.rm(u.file, { force: true }).catch(() => {});
    }
  }
}, 30 * 60 * 1000);
uploadSweep.unref?.();

// in-memory job store (fine for MVP; swap for a DB later)
const jobs = new Map(); // id -> { logs:[], status, clips:[], error }

// Start a clipping job — requires login; enforces the user's plan limits.
app.post("/api/clip", async (req, res) => {
  const user = req.user;
  if (!user) return res.status(401).json({ error: "Please log in to generate clips." });

  const { url, uploadId, voiceover: voiceoverReq, voice, caption, length, clips: clipsReq, range, motion, layout } = req.body || {};

  // Accept "youtube.com/watch?v=..." the way a browser would.
  const cleanUrl = url && !/^https?:\/\//i.test(url) ? "https://" + String(url).trim() : url;

  // Either an uploaded file (reliable) or a link (can be blocked by the source).
  let sourceFile = null;
  if (uploadId) {
    const up = uploads.get(uploadId);
    if (!up || up.userId !== user.id) {
      return res.status(400).json({ error: "That upload has expired — please upload the file again." });
    }
    sourceFile = up.file;
  } else if (!url) {
    return res.status(400).json({ error: "Paste a video link or upload a file." });
  } else if (!/^https?:\/\//i.test(url) && !/^[\w-]+(\.[\w-]+)+\//.test(url)) {
    // Be specific: an empty box and a malformed link are different problems.
    return res.status(400).json({
      error: `That doesn't look like a video link: "${String(url).slice(0, 60)}". Paste the full URL from your browser's address bar.`,
    });
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
  const chosenMotion = ["none", "subtle", "strong"].includes(motion) ? motion : "subtle";
  const chosenLayout = ["crop", "fit"].includes(layout) ? layout : "crop";

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
  const job = {
    id, logs: [], status: "running", clips: [], error: null,
    stage: "queued", progress: 0, detail: null, errorCode: null,
  };
  job.abort = new AbortController();
  job.children = new Set();
  job.userId = user.id;
  console.log(`\n▶ [${id.slice(0, 6)}] new job — ${user.email} — ${sourceFile ? "uploaded file" : url}`);
  jobs.set(id, job);
  res.json({ jobId: id });

  const short = id.slice(0, 6);
  const log = (msg) => {
    job.logs.push({ t: Date.now(), msg });
    // Mirror to the terminal so you can watch a run without opening the browser.
    // yt-dlp/ffmpeg chatter is noisy, so keep those out unless DEBUG_JOBS=1.
    const noisy = /^\[(download|youtube|info|Merger|ExtractAudio)|^\s*(frame|size)=|out_time_ms/.test(msg);
    if (!noisy || process.env.DEBUG_JOBS) console.log(`[${short}] ${msg}`);
  };
  const onProgress = (stage, pct, detail) => {
    job.stage = stage;
    job.progress = Math.max(job.progress, pct); // never go backwards
    job.detail = detail || null;
  };

  try {
    // Scope model-call logging to this job so concurrent runs don't mix.
    const { workDir, clips } = await withJob(
      { signal: job.abort.signal, children: job.children },
      () => withAiLogger(log, () => makeClips(cleanUrl, log, {
      maxClips: chosenClips,
      resolution: plan.resolution,
      voiceover: wantVoiceover,
      voice: chosenVoice,
      caption: chosenCaption,
      length: chosenLength,
      range: chosenRange,
      motion: chosenMotion,
      layout: chosenLayout,
      sourceFile,
      onProgress,
      // With a helper connected, links are fetched on the user's own machine
      // (a residential IP YouTube trusts) instead of from this server.
      externalDownload: (!sourceFile && workerEnabled() && !isDirectMedia(normalizeUrl(cleanUrl).url))
        ? (u, dir, l) => requestDownload(u, dir, l)
        : null,
    })));
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
    job.stage = "done"; job.progress = 100;
    console.log(`✓ [${id.slice(0, 6)}] done — ${published.length} clips`);
    // save this batch to the user's "My Reels" library
    addReels(user.id, published, cleanUrl);
    // best-effort cleanup of the temp working dir (and the uploaded source)
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    if (uploadId && uploads.has(uploadId)) {
      const up = uploads.get(uploadId);
      uploads.delete(uploadId);
      fs.rm(up.file, { force: true }).catch(() => {});
    }
  } catch (err) {
    if (err instanceof Cancelled || job.abort.signal.aborted) {
      job.status = "cancelled";
      job.error = "Cancelled — you were not charged for this run.";
      job.stage = "cancelled";
      // The quota was taken up-front to cap spend; give it back.
      refundVideoUsage(user);
      console.log(`✖ [${id.slice(0, 6)}] cancelled by user — quota refunded`);
      return;
    }
    job.status = "error";
    job.error = err.message;
    // Short code the user can quote when reporting a problem; the full detail
    // stays in the job so support can look it up.
    job.errorCode = "MIR-" + id.replace(/-/g, "").slice(0, 6).toUpperCase();
    console.error(`[${job.errorCode}] job ${id} failed:`, err.message);
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

  // Direct media (podcast episode, Drive/Dropbox share, public mp4): ffprobe can
  // read the duration straight off the remote file — no extractor involved.
  const norm = normalizeUrl(url);
  if (isDirectMedia(norm.url)) {
    try {
      const duration = await probeDurationSec(norm.url);
      if (duration && isFinite(duration)) {
        return cacheAndSend({
          title: decodeURIComponent((norm.url.split("/").pop() || "Media").split("?")[0]),
          author: null, duration, thumbnail: null, direct: true,
        });
      }
    } catch { /* fall through */ }
  }

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

// Podcast feed -> episode list. Feeds publish direct media URLs meant for
// downloading, so this source can't be bot-blocked like YouTube.
const feedCache = new Map();

app.get("/api/podcast", async (req, res) => {
  const url = String(req.query.url || "");
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: "Paste a podcast RSS feed URL." });

  if (feedCache.has(url)) return res.json(feedCache.get(url));
  try {
    const data = await fetchPodcastFeed(url);
    feedCache.set(url, data);
    if (feedCache.size > 50) feedCache.delete(feedCache.keys().next().value);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not read that feed." });
  }
});

// Which build is actually running? Included in error reports so a stale
// cached page is obvious instead of looking like a fresh bug.
const BUILD = (process.env.RENDER_GIT_COMMIT || "dev").slice(0, 7);
const STARTED = new Date().toISOString();
app.get("/api/version", (_req, res) => res.json({ build: BUILD, started: STARTED }));

// Is a download helper connected? (drives the UI hint)
app.get("/api/worker-status", (req, res) => {
  res.json({ enabled: workerEnabled(), online: workerOnline() });
});

// Stop a running job. Kills the tools mid-flight and aborts API calls, so
// cancelling early genuinely avoids the spend.
app.post("/api/jobs/:id/cancel", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (!req.user || job.userId !== req.user.id) {
    return res.status(403).json({ error: "That isn't your job." });
  }
  if (job.status !== "running") return res.json({ ok: true, status: job.status });

  job.abort.abort();
  for (const child of job.children) { try { child.kill("SIGKILL"); } catch {} }
  job.logs.push({ t: Date.now(), msg: "Cancelled by user." });
  res.json({ ok: true, status: "cancelling" });
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
    errorCode: job.errorCode,
    stage: job.stage,
    progress: job.progress,
    detail: job.detail,
  });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`\n\x1b[32m●\x1b[0m MakeItReel running on \x1b[1mhttp://localhost:${PORT}\x1b[0m`);
  console.log(`  Press \x1b[1mCtrl+C\x1b[0m to stop.\n`);
});

// Shut down cleanly and say so, and make sure closing the terminal
// (SIGHUP) takes the server with it rather than leaving it orphaned.
let stopping = false;
function shutdown(signal) {
  if (stopping) { process.exit(1); }   // second Ctrl+C: don't wait
  stopping = true;

  const running = [...jobs.values()].filter((j) => j.status === "running").length;
  console.log(`\n\x1b[33m■\x1b[0m Stopping MakeItReel (${signal})…`);
  if (running) console.log(`  ${running} job${running > 1 ? "s were" : " was"} still running and will not finish.`);

  server.close(() => {
    console.log(`\x1b[31m●\x1b[0m MakeItReel has stopped. localhost:${PORT} is no longer served.\n`);
    process.exit(0);
  });
  // Don't hang forever on lingering connections.
  setTimeout(() => {
    console.log(`\x1b[31m●\x1b[0m MakeItReel has stopped.\n`);
    process.exit(0);
  }, 3000).unref();
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => shutdown(sig));
