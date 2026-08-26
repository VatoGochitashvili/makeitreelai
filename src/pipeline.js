// MakeItReel core pipeline.
// Flow: download -> transcribe -> AI picks best moments -> cut vertical clips with captions.
//
// Requires two command-line tools installed on the machine:
//   - yt-dlp   (downloads the source video)
//   - ffmpeg   (cuts, reframes to 9:16, burns captions)
// On Replit add them via the "System dependencies" / nix packages: yt-dlp, ffmpeg.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import OpenAI from "openai";
import { createReadStream, existsSync, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { normalizeUrl, isDirectMedia } from "./sources.js";

// Lazily create the OpenAI client. Constructing it at import time throws when
// OPENAI_API_KEY is unset, which would crash the whole server on boot — so we
// defer it until a clip job actually needs it (server.js already rejects jobs
// with a clear error when the key is missing).
let _openai;
function openai() {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set on the server.");
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}
const MAX_CLIPS = parseInt(process.env.MAX_CLIPS || "6", 10);

// Homebrew's default ffmpeg is built without libass/freetype, so captions
// silently don't render. ffmpeg-full has them but is keg-only (off PATH).
// Prefer it when present so local runs match production.
function pickBin(name) {
  const override = process.env[name.toUpperCase() + "_BIN"];
  if (override) return override;
  const full = `/opt/homebrew/opt/ffmpeg-full/bin/${name}`;
  return existsSync(full) ? full : name;
}
const FFMPEG = pickBin("ffmpeg");
const FFPROBE = pickBin("ffprobe");

// --- small helper: run a shell command and capture output ---
function run(cmd, args, { onLog } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stderr = "";
    p.stdout.on("data", (d) => onLog && onLog(d.toString()));
    p.stderr.on("data", (d) => { stderr += d.toString(); onLog && onLog(d.toString()); });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-500)}`))
    );
  });
}

// Shared yt-dlp args to survive cloud/datacenter IP blocks. YouTube bot-flags
// datacenter IPs, so on a server you usually need cookies (a Netscape
// cookies.txt from a logged-in browser) and/or a proxy. Provide them with:
//   YTDLP_COOKIES     - path to a cookies.txt file
//   YTDLP_PROXY       - http/https/socks proxy URL
//   YTDLP_ARGS        - any extra raw args (space-separated)
function ytdlpCommon(session) {
  const args = ["--no-warnings", "--retries", "5", "--extractor-retries", "5", "--sleep-requests", "1"];
  if (process.env.YTDLP_COOKIES && existsSync(process.env.YTDLP_COOKIES)) {
    args.push("--cookies", process.env.YTDLP_COOKIES);
  }
  if (process.env.YTDLP_PROXY) args.push("--proxy", resolveProxy(session));
  if (process.env.YTDLP_ARGS) args.push(...process.env.YTDLP_ARGS.split(" ").filter(Boolean));
  return args;
}

// Residential providers hand out a new IP per "session id". Put {session}
// anywhere in YTDLP_PROXY (IPRoyal, for example, takes it in the password:
// user:pass_country-us_session-{session}_lifetime-30m) and each retry gets a
// fresh IP instead of hammering the one that just got blocked.
function resolveProxy(session) {
  const raw = process.env.YTDLP_PROXY || "";
  if (!raw.includes("{session}")) return raw;
  return raw.replace(/\{session\}/g, session || Math.random().toString(36).slice(2, 10));
}

// Turn yt-dlp's bot-block errors into something the user can act on.
function friendlyDownloadError(msg) {
  // A stale yt-dlp is the usual cause of sudden 403s on video data.
  if (/403|Forbidden|page needs to be reloaded|No video formats found/i.test(msg)) {
    return "YouTube refused this download. This usually means the downloader is out of date — " +
      "updating yt-dlp fixes it (redeploy the server, or run `brew upgrade yt-dlp` on the machine " +
      "running the helper). If it persists, the video may be DRM-protected; try uploading the file instead.";
  }
  if (/Sign in to confirm|not a bot|429|Too Many Requests|cookies/i.test(msg)) {
    return "YouTube is blocking this download (it does that to servers, not to you). " +
      "Try one of these instead — they can't be blocked: upload the file directly " +
      "(if it's your own video, download it from YouTube Studio first), paste a podcast " +
      "RSS feed, or use a Google Drive / Dropbox share link.";
  }
  return msg;
}

// --- small helper: read a media file's duration in seconds via ffprobe ---
export function probeDurationSec(file) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFPROBE, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file,
    ]);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve(parseFloat(out.trim())) : reject(new Error(`ffprobe exited ${code}: ${err.slice(-300)}`))
    );
  });
}

// zoompan re-times video to whatever fps you give it, so we must feed it the
// source rate or clips come out shorter than they should be.
function probeFps(file) {
  return new Promise((resolve) => {
    const p = spawn(FFPROBE, ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", file]);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", () => resolve(30));
    p.on("close", () => {
      const [n, d] = out.trim().split("/").map(Number);
      const fps = d ? n / d : n;
      resolve(fps && isFinite(fps) && fps > 0 ? fps : 30);
    });
  });
}

// Some ffmpeg builds ship without libfreetype (no `drawtext` filter). Detect
// once so we can burn captions when possible and skip them gracefully if not.
let _drawtext;
function hasDrawtext() {
  if (_drawtext !== undefined) return Promise.resolve(_drawtext);
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-filters"]);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", () => resolve((_drawtext = false)));
    p.on("close", () => resolve((_drawtext = /\bdrawtext\b/.test(out))));
  });
}

// Podcasts are often audio-only — we then render an "audiogram" instead of
// cropping video. Detect which we're dealing with.
export function hasVideoStream(file) {
  return new Promise((resolve) => {
    const p = spawn(FFPROBE, [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=codec_type", "-of", "csv=p=0", file,
    ]);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", () => resolve(false));
    p.on("close", () => resolve(/video/.test(out)));
  });
}

// Fetch a plain media URL (podcast episode, Drive/Dropbox share, public mp4).
// These are meant to be downloaded, so no extractor and no bot-blocking.
async function downloadDirect(url, workDir, log) {
  log("Downloading media…");
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "MakeItReel/1.0" },
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`Source returned ${res.status} — is the link public?`);

  const ct = res.headers.get("content-type") || "";
  if (/text\/html/i.test(ct)) {
    throw new Error("That link returned a web page, not a media file. Use a direct/public file link.");
  }
  const ext = /audio\//.test(ct) ? ".mp3" : ".mp4";
  const out = path.join(workDir, "source" + ext);
  await streamPipeline(Readable.fromWeb(res.body), createWriteStream(out));
  const mb = ((await fs.stat(out)).size / 1e6).toFixed(1);
  log(`Downloaded ${mb} MB.`);
  return out;
}

// Whisper rejects uploads over 25MB; stay safely under it.
const WHISPER_LIMIT_BYTES = 24 * 1024 * 1024;
// At 64kbps mono a 15-min chunk is ~7MB — comfortably under the limit.
const TRANSCRIBE_CHUNK_SEC = 15 * 60;

// Send one audio file to Whisper and return its segments.
// Rough public per-unit prices, only used to show what a run costs.
const PRICE = { whisperPerMin: 0.006, gptInPer1k: 0.00015, gptOutPer1k: 0.0006, ttsPer1k: 0.015 };
let aiLog = () => {};
export function setAiLogger(fn) { aiLog = fn || (() => {}); }

async function transcribeFile(file) {
  const t0 = Date.now();
  const mb = ((await fs.stat(file)).size / 1e6).toFixed(1);
  aiLog(`  🤖 Whisper (whisper-1): uploading ${mb} MB…`);
  const res = await openai().audio.transcriptions.create({
    file: createReadStream(file),
    model: "whisper-1",
    response_format: "verbose_json",
    // Word timings are what make animated, karaoke-style captions possible.
    // Same call, same cost — we just ask for more detail.
    timestamp_granularities: ["segment", "word"],
  });
  const mins = (res.duration || 0) / 60;
  aiLog(`  🤖 Whisper done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ` +
        `${(res.segments || []).length} segments, ${(res.words || []).length} words, ` +
        `~$${(mins * PRICE.whisperPerMin).toFixed(3)}`);
  return { segments: res.segments || [], words: res.words || [] };
}

// Fetch source metadata (title, duration, thumbnail) without downloading the
// video — used to draw the range selector before generating.
export function probeVideoMeta(url) {
  return new Promise((resolve, reject) => {
    const p = spawn("yt-dlp", [
      ...ytdlpCommon(), "--dump-single-json", "--skip-download", "--no-playlist", url,
    ]);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    const kill = setTimeout(() => p.kill("SIGKILL"), 25000);
    p.on("close", (code) => {
      clearTimeout(kill);
      if (code !== 0) return reject(new Error(err.slice(-200) || `yt-dlp exited ${code}`));
      try {
        const d = JSON.parse(out);
        resolve({
          title: d.title,
          author: d.uploader || d.channel,
          duration: typeof d.duration === "number" ? d.duration : null,
          thumbnail: d.thumbnail,
        });
      } catch (e) { reject(new Error("Could not parse video metadata.")); }
    });
  });
}

// --- 1. download the source video ---
async function downloadVideo(rawUrl, workDir, log) {
  // Share links (Drive/Dropbox) become direct-download links; plain media URLs
  // and podcast episodes are fetched straight, bypassing yt-dlp entirely.
  const { url } = normalizeUrl(rawUrl);
  if (isDirectMedia(url)) return downloadDirect(url, workDir, log);

  log("Downloading video…");
  const out = path.join(workDir, "source.mp4");

  // YouTube blocks its player clients unevenly — one often works when others
  // are refused, so try them in turn instead of giving up after the default.
  // Ordered cheapest/most-likely first.
  const clients = (process.env.YTDLP_CLIENTS
    || "default,tv,ios,mweb,web_embedded,tv_embedded,android")
    .split(",").map((c) => c.trim()).filter(Boolean);

  let lastErr;
  for (const client of clients) {
    const args = [
      ...ytdlpCommon(),
      "-f", "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      "--merge-output-format", "mp4",
      "-o", out,
      url,
    ];
    if (client !== "default") args.push("--extractor-args", `youtube:player_client=${client}`);

    try {
      await run("yt-dlp", args, { onLog: (l) => log(l.trim()) });
      if (client !== "default") log(`(succeeded using the "${client}" player)`);
      return out;
    } catch (err) {
      lastErr = err;
      // Only worth retrying when we were blocked/refused; a genuinely missing
      // or private video will fail the same way on every client.
      if (!/Sign in to confirm|not a bot|429|Too Many Requests|Requested format|unable to download|403/i.test(err.message)) break;
      await fs.rm(out, { force: true }).catch(() => {});
      log(`"${client}" player was blocked — trying another…`);
    }
  }
  throw new Error(friendlyDownloadError(lastErr ? lastErr.message : "Download failed."));
}

// Bandwidth is the dominant cost when downloading through a proxy, and we
// don't need the whole video: transcription only needs audio, and only the
// chosen moments need pictures. So for link sources we fetch audio first,
// then just the seconds the AI picked — typically ~90% less data.
async function downloadAudioOnly(url, workDir, log, range) {
  log("Downloading audio for analysis…");
  const out = path.join(workDir, "analysis.m4a");
  const args = [
    ...ytdlpCommon(),
    "-f", "bestaudio[ext=m4a]/bestaudio/best",
    "-o", out,
  ];
  if (range) args.push("--download-sections", `*${Math.floor(range.start)}-${Math.ceil(range.end)}`);
  args.push(url);
  await run("yt-dlp", args, { onLog: (l) => log(l.trim()) });
  const mb = ((await fs.stat(out)).size / 1e6).toFixed(1);
  log(`Audio downloaded (${mb} MB).`);
  return out;
}

// Fetch just one moment as video. Returns the local file for that section.
async function downloadSection(url, workDir, log, start, end, index) {
  const out = path.join(workDir, `sec_${index + 1}.mp4`);
  const args = [
    ...ytdlpCommon(),
    "-f", "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    "--download-sections", `*${Math.floor(start)}-${Math.ceil(end)}`,
    "--force-keyframes-at-cuts",
    "--merge-output-format", "mp4",
    "-o", out,
    url,
  ];
  await run("yt-dlp", args);
  return out;
}

// --- 2. transcribe with timestamps (Whisper) ---
async function transcribe(videoPath, workDir, log, range = null) {
  // Only transcribe the slice the user selected — cheaper, and it keeps every
  // clip inside their chosen interval. Offset is added back at the end so all
  // timestamps stay absolute against the source video.
  const offset = range ? Math.max(0, range.start) : 0;
  if (range) {
    const mins = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
    log(`Transcribing audio from ${mins(range.start)} to ${mins(range.end)}…`);
  } else {
    log("Transcribing audio…");
  }

  // Extract a compressed audio track first (smaller upload, cheaper).
  // This is CPU-bound and can take minutes on a small instance, so say what's
  // happening rather than going silent.
  const audio = path.join(workDir, "audio.mp3");
  const srcMb = ((await fs.stat(videoPath)).size / 1e6).toFixed(0);
  log(`Extracting audio from a ${srcMb} MB file (this is the slow part on small servers)…`);

  const extract = ["-y"];
  if (range) extract.push("-ss", String(range.start), "-t", String(range.end - range.start));
  extract.push("-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k",
    "-threads", "0", "-loglevel", "error", "-stats_period", "20", "-progress", "pipe:1", audio);

  const t0 = Date.now();
  let lastNote = 0;
  await run(FFMPEG, extract, {
    onLog: (line) => {
      // ffmpeg -progress emits out_time_ms=...; report every ~20s
      const m = /out_time_ms=(\d+)/.exec(line);
      if (m && Date.now() - lastNote > 20000) {
        lastNote = Date.now();
        log(`  …extracted ${Math.round(Number(m[1]) / 1e6)}s of audio so far`);
      }
    },
  });
  log(`Audio extracted in ${Math.round((Date.now() - t0) / 1000)}s.`);

  const shift = (arr) => (offset ? arr.map((x) => ({ ...x, start: x.start + offset, end: x.end + offset })) : arr);
  const size = (await fs.stat(audio)).size;

  // Short enough for a single upload.
  if (size <= WHISPER_LIMIT_BYTES) {
    const r = await transcribeFile(audio);
    return { segments: shift(r.segments), words: shift(r.words) };
  }

  // Long podcasts exceed Whisper's 25MB limit — split into time chunks,
  // transcribe each, and shift every segment back onto the full timeline.
  const dur = await probeDurationSec(audio);
  const nChunks = Math.ceil(dur / TRANSCRIBE_CHUNK_SEC);
  log(`Audio is ${(size / 1e6).toFixed(0)}MB (over Whisper's 25MB limit) — transcribing in ${nChunks} chunks…`);

  const segments = [], words = [];
  for (let i = 0; i < nChunks; i++) {
    const start = i * TRANSCRIBE_CHUNK_SEC;
    const chunk = path.join(workDir, `chunk_${i}.mp3`);
    // -ss before -i seeks by input; -c copy keeps it fast and lossless.
    await run(FFMPEG, ["-y", "-ss", String(start), "-t", String(TRANSCRIBE_CHUNK_SEC), "-i", audio, "-c", "copy", chunk]);

    // A tiny trailing remainder can be effectively empty — skip it.
    if ((await fs.stat(chunk)).size < 3000) continue;

    log(`  transcribing chunk ${i + 1}/${nChunks}…`);
    const r = await transcribeFile(chunk);
    for (const x of r.segments) segments.push({ ...x, start: x.start + start, end: x.end + start });
    for (const w of r.words) words.push({ ...w, start: w.start + start, end: w.end + start });
  }
  return { segments: shift(segments), words: shift(words) };
}

// Clip-length presets the user can pick before generating.
export const LENGTHS = {
  // Auto lets each clip be as long as its idea needs — a punchline can be 20s
  // while a story runs two minutes, which is what makes a set feel natural.
  auto:   { label: "Auto",             range: "20-120 seconds", min: 20, max: 120, varied: true },
  short:  { label: "Short (15–30s)",   range: "15-32 seconds", min: 15, max: 32 },
  medium: { label: "Medium (30–45s)",  range: "28-50 seconds", min: 28, max: 50 },
  long:   { label: "Long (45–60s)",    range: "45-75 seconds", min: 45, max: 75 },
};

// The model's timestamps are approximations, so a clip often starts mid-word
// and ends mid-thought. Snap each pick to real speech boundaries from the
// transcript, grow it until it's long enough to make sense, and trim it back
// if it overruns. This is what turns "a fragment" into "a clip".
function refineMoments(clips, segments, min, max, log) {
  if (!segments.length) return clips;
  const out = [];

  for (const c of clips) {
    // First segment that is still speaking at the proposed start.
    let i = segments.findIndex((s) => s.end > c.start);
    if (i === -1) i = 0;
    // First segment that finishes at or after the proposed end.
    let j = segments.findIndex((s) => s.end >= c.end);
    if (j === -1) j = segments.length - 1;
    if (j < i) j = i;

    const dur = () => segments[j].end - segments[i].start;

    // Too short to stand alone: keep the hook where it is and let the thought
    // finish; only reach backwards if there's nothing left ahead.
    while (dur() < min && j < segments.length - 1) j++;
    while (dur() < min && i > 0) i--;
    // Overran: pull the end back to the previous sentence boundary.
    while (dur() > max && j > i) j--;

    const start = segments[i].start;
    const end = segments[j].end;
    if (end - start < Math.max(8, min * 0.6)) continue; // genuinely nothing there

    out.push({ ...c, start, end });
  }

  // Snapping can collapse two different picks onto the same sentences, which
  // would ship the viewer duplicate clips. Keep the first, drop heavy overlaps.
  out.sort((a, b) => a.start - b.start);
  const unique = [];
  for (const c of out) {
    const clash = unique.find((u) => {
      const overlap = Math.min(u.end, c.end) - Math.max(u.start, c.start);
      return overlap > 0 && overlap > 0.5 * Math.min(u.end - u.start, c.end - c.start);
    });
    if (!clash) unique.push(c);
  }

  const dropped = clips.length - unique.length;
  if (dropped > 0) log(`  (skipped ${dropped} moment${dropped > 1 ? "s" : ""}: too short or overlapping)`);
  return unique;
}

// --- 3. ask the LLM to pick the best clip-worthy moments ---
async function selectMoments(segments, log, maxClips = MAX_CLIPS, lengthPref = "auto") {
  log("AI is finding the best moments…");
  // Build a compact timestamped transcript for the model
  const transcript = segments
    .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text.trim()}`)
    .join("\n");

  const L = LENGTHS[lengthPref] || LENGTHS.auto;
  const prompt = `You are an expert short-form video editor. Below is a timestamped transcript of a longer video.

Choose the ${maxClips} best moments to become standalone vertical clips.

A good clip is a COMPLETE THOUGHT, not a fragment. Each one must:
1. Start exactly where a sentence starts — never mid-sentence, and never on a
   filler connective ("and so", "but yeah", "anyway"). The first line has to
   work as a hook on its own.
2. Contain the whole idea: the setup AND the payoff. If someone asks a
   question, include the answer. If a story starts, include how it ends.
3. End after the point lands — on the last sentence of that thought, not
   partway into the next topic.
4. Make sense to a viewer who has not seen the rest of the video. No dangling
   "he" or "that thing" with no referent.
5. Be ${L.min}-${L.max} seconds long. If a thought is shorter than ${L.min}s,
   include the surrounding sentences that complete it, or choose a different
   moment. Never return anything under ${L.min} seconds.${L.varied ? `
6. VARY the lengths — this matters. Do NOT return clips that are all roughly
   the same length, and do not default to the minimum. Aim for a spread:
     - some short and punchy (20-35s): a single sharp point or punchline
     - some medium (40-70s): a point with its explanation
     - at least one long (75-120s) if the transcript contains a full story,
       argument, or explanation worth hearing end to end
   Let each clip run as long as its idea genuinely needs.` : ""}

Spread your picks across the whole transcript rather than clustering them in
one section.

Prefer moments with a strong hook, a surprising insight, a punchline, a
concrete story, or a quotable line.

Use the timestamps exactly as given in the transcript for start and end.

Return ONLY valid JSON in this exact shape:
{"clips":[{"start":<seconds>,"end":<seconds>,"title":"<catchy title, max 8 words>","hook":"<the opening sentence>","virality":<1-100>}]}

Transcript:
${transcript}`;

  const gptT0 = Date.now();
  aiLog(`  🤖 GPT (gpt-4o-mini): analysing ${segments.length} transcript segments…`);
  const completion = await openai().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0.4,
  });

  const u = completion.usage || {};
  aiLog(`  🤖 GPT done in ${((Date.now() - gptT0) / 1000).toFixed(1)}s — ` +
        `${u.prompt_tokens || 0} in / ${u.completion_tokens || 0} out tokens, ` +
        `~$${(((u.prompt_tokens || 0) / 1000) * PRICE.gptInPer1k +
              ((u.completion_tokens || 0) / 1000) * PRICE.gptOutPer1k).toFixed(4)}`);

  let data;
  try {
    data = JSON.parse(completion.choices[0].message.content);
  } catch {
    throw new Error("AI returned invalid JSON while selecting moments.");
  }
  const raw = (data.clips || [])
    .filter((c) => typeof c.start === "number" && typeof c.end === "number" && c.end > c.start)
    .slice(0, maxClips);

  const clips = refineMoments(raw, segments, L.min, L.max, log);
  const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}`;
  log(`AI selected ${clips.length} moments (${clips.map((c) => Math.round(c.end - c.start) + "s").join(", ")}).`);
  clips.forEach((c, i) => log(`  ${i + 1}. ${mmss(c.start)}–${mmss(c.end)} "${c.title || "untitled"}"`));
  return clips;
}

// Does this ffmpeg know how to burn .ass subtitles? (needs libass)
let _libass;
function hasSubtitles() {
  if (_libass !== undefined) return Promise.resolve(_libass);
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ["-hide_banner", "-filters"]);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", () => resolve((_libass = false)));
    p.on("close", () => resolve((_libass = /\bsubtitles\b/.test(out))));
  });
}

function assTime(sec) {
  const t = Math.max(0, sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(2).padStart(5, "0");
  return `${h}:${String(m).padStart(2, "0")}:${s}`;
}

// Animated captions: show 2-3 words at a time, timed to when they're spoken.
// This is what makes clips read as "professionally captioned" rather than
// carrying one static title.
function buildAss(words, { W, H, style, position, size }) {
  const sizeScale = { small: 0.8, medium: 1, large: 1.25 }[size] || 1;
  const fontSize = Math.round((W / 13) * sizeScale);

  // Colours are ASS &HBBGGRR (note: blue-green-red order).
  const looks = {
    bold:      { primary: "&H00FFFFFF", outline: "&H00000000", back: "&H00000000", border: 3, shadow: 2, boxed: 0 },
    highlight: { primary: "&H000D0705", outline: "&H00BEF264", back: "&H00BEF264", border: 4, shadow: 0, boxed: 3 },
    minimal:   { primary: "&H00FFFFFF", outline: "&H00000000", back: "&H00000000", border: 2, shadow: 3, boxed: 0 },
  };
  const look = looks[style] || looks.bold;

  // 2 = bottom-centre, 5 = middle, 8 = top-centre
  const align = position === "top" ? 8 : position === "center" ? 5 : 2;
  const vMargin = Math.round(H * (position === "center" ? 0.05 : 0.12));

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Cap,DejaVu Sans,${fontSize},${look.primary},${look.primary},${look.outline},${look.back},-1,0,0,0,100,100,0,0,${look.boxed ? 3 : 1},${look.border},${look.shadow},${align},60,60,${vMargin},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  // Group words into short phrases, breaking on natural pauses.
  const lines = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const start = group[0].start;
    const end = group[group.length - 1].end;
    const text = group.map((w) => w.word.trim()).join(" ").toUpperCase()
      .replace(/[{}\\]/g, "");   // ASS control chars
    lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Cap,,0,0,0,,${text}`);
    group = [];
  };
  for (let i = 0; i < words.length; i++) {
    group.push(words[i]);
    const next = words[i + 1];
    const gap = next ? next.start - words[i].end : 0;
    const long = group.map((w) => w.word).join(" ").length > 18;
    if (group.length >= 3 || long || gap > 0.35 || !next) flush();
  }
  return header + "\n" + lines.join("\n") + "\n";
}

// 9:16 dimensions for a given target resolution (long edge height).
function dims(resolution) {
  return resolution >= 1080 ? { W: 1080, H: 1920 } : { W: 720, H: 1280 };
}

// On-screen caption styles the user can choose before generating.
// `draw` returns the ffmpeg drawtext options for the chosen look.
export const CAPTION_STYLES = {
  bold: {
    label: "Bold Impact",
    draw: (size) => `fontcolor=white:fontsize=${size}:box=1:boxcolor=black@0.55:boxborderw=18`,
  },
  highlight: {
    label: "Lime Highlight",
    draw: (size) => `fontcolor=0x05070d:fontsize=${size}:box=1:boxcolor=0x64f2be@0.95:boxborderw=16`,
  },
  minimal: {
    label: "Clean Minimal",
    draw: (size) => `fontcolor=white:fontsize=${Math.round(size * 0.9)}:shadowcolor=black@0.8:shadowx=3:shadowy=3`,
  },
  none: { label: "No captions", draw: null },
};

// Vertical placement of the caption within the 9:16 frame.
const CAPTION_POSITIONS = {
  top: (H) => String(Math.round(H * 0.073)),
  center: () => "(h-text_h)/2",
  bottom: (H) => String(Math.round(H * 0.78)),
};

// --- 4. cut each moment into a vertical 9:16 clip with a title caption ---
// Render an "audiogram" for audio-only sources (most podcasts): a branded
// vertical card with a live waveform and the clip title.
async function cutAudiogram(srcPath, clip, index, workDir, resolution, caption, log) {
  const out = path.join(workDir, `clip_${index + 1}.mp4`);
  const dur = Math.max(1, clip.end - clip.start);
  const { W, H } = dims(resolution);
  const style = CAPTION_STYLES[caption?.style] || CAPTION_STYLES.bold;
  const sizeScale = { small: 0.8, medium: 1, large: 1.25 }[caption?.size] || 1;
  const fontsize = Math.round((W / 18) * sizeScale);
  const title = (clip.title || "")
    .replace(/'/g, "’").replace(/:/g, " ").slice(0, 60)
    .replace(/(.{1,20})(\s+|$)/g, "$1\n").trim();

  log(`Rendering audiogram ${index + 1} @${H}p: "${clip.title || "untitled"}"…`);

  // background colour + waveform strip drawn over it, then the title text
  const waveH = Math.round(H * 0.26);
  // dynaudnorm levels the audio *for the visual only*, so quiet and loud
  // podcasts both produce a full waveform. White avoids the colour-space
  // shifts some ffmpeg builds apply to tinted showwaves output.
  const chain = [
    `[1:a]dynaudnorm,showwaves=s=${W}x${waveH}:mode=cline:rate=25:draw=full:colors=white[wave]`,
    `[0:v][wave]overlay=0:(H-h)/2:shortest=1[bg]`,
  ];
  const drawable = style.draw && await hasDrawtext();
  chain.push(drawable
    ? `[bg]drawtext=text='${title}':${style.draw(fontsize)}:x=(w-text_w)/2:y=${Math.round(H * 0.16)}:line_spacing=10[v]`
    : `[bg]null[v]`);

  await run(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", `color=c=0x0b1020:s=${W}x${H}:d=${dur}`,
    "-ss", String(clip.start), "-t", String(dur), "-i", srcPath,
    "-filter_complex", chain.join(";"),
    "-map", "[v]", "-map", "1:a",
    "-r", "25", "-pix_fmt", "yuv420p",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
    "-t", String(dur), out,
  ]);
  return out;
}

async function cutClip(videoPath, clip, index, workDir, resolution, caption, log, words, motion = "subtle") {
  const out = path.join(workDir, `clip_${index + 1}.mp4`);
  const dur = Math.max(1, clip.end - clip.start);
  const { W, H } = dims(resolution);
  const style = CAPTION_STYLES[caption?.style] || CAPTION_STYLES.bold;
  const sizeScale = { small: 0.8, medium: 1, large: 1.25 }[caption?.size] || 1;
  const fontsize = Math.round((W / 20) * sizeScale); // ~54 @1080, ~36 @720
  const yPos = (CAPTION_POSITIONS[caption?.position] || CAPTION_POSITIONS.top)(H);

  // Escape the title for ffmpeg drawtext, and wrap so long titles fit the frame.
  const title = (clip.title || "")
    .replace(/'/g, "’").replace(/:/g, " ").slice(0, 60)
    .replace(/(.{1,24})(\s+|$)/g, "$1\n").trim();

  // Filter: scale up, crop center to 9:16, then (if supported) draw the title.
  // Normalize fps/pixfmt/audio so clips can be safely concatenated with an intro.
  // Scale to COVER the 9:16 frame (works for landscape or portrait sources),
  // then center-crop. Scaling only the width broke on landscape videos.
  const filters = [
    `scale=${W}:${H}:force_original_aspect_ratio=increase`,
    `crop=${W}:${H}`,
  ];

  // A slow, continuous push-in. Static centre crops read as flat; a gentle
  // zoom keeps the frame alive the way edited shorts do. Applied before the
  // captions so the text stays pinned and crisp.
  if (motion !== "none") {
    const fps = await probeFps(videoPath);
    const total = Math.max(1, Math.round(dur * fps));
    const amount = motion === "strong" ? 0.18 : 0.09;
    filters.push(
      `zoompan=z='min(1+${amount}*on/${total},${(1 + amount).toFixed(2)})'` +
      `:d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps.toFixed(4)}`
    );
  }
  // Preferred: animated word-timed captions burned from an .ass file.
  let assPath = null;
  if (style.draw && words && words.length && await hasSubtitles()) {
    // Words for this clip, shifted so the clip starts at 0.
    const local = words
      .filter((w) => w.end > clip.start && w.start < clip.end)
      .map((w) => ({
        word: w.word,
        start: Math.max(0, w.start - clip.start),
        end: Math.max(0.1, w.end - clip.start),
      }));
    if (local.length) {
      assPath = path.join(workDir, `cap_${index + 1}.ass`);
      await fs.writeFile(assPath, buildAss(local, {
        W, H, style: caption?.style, position: caption?.position, size: caption?.size,
      }));
      // ffmpeg needs the path escaped inside the filter string
      const esc = assPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
      filters.push(`subtitles='${esc}'`);
      if (index === 0) log("Burning animated word-by-word captions…");
    }
  }

  if (!assPath && style.draw && await hasDrawtext()) {
    filters.push(`drawtext=text='${title}':${style.draw(fontsize)}:x=(w-text_w)/2:y=${yPos}:line_spacing=8`);
  } else if (!assPath && style.draw && index === 0) {
    log("Note: this ffmpeg build has no 'drawtext' filter — clips will render without burned-in captions.");
  }
  const vf = filters.join(",");

  log(`Cutting clip ${index + 1} @${H}p: "${clip.title || "untitled"}"…`);
  await run(FFMPEG, [
    "-y",
    "-ss", String(clip.start),
    "-i", videoPath,
    "-t", String(dur),
    "-vf", vf,
    // Keep the source frame rate (a 50/60fps source stays smooth) and encode
    // at higher quality — social platforms re-compress, so we upload clean.
    "-pix_fmt", "yuv420p",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-maxrate", "16M", "-bufsize", "24M",
    "-profile:v", "high", "-level", "4.2",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart",
    out,
  ]);
  return out;
}

// --- 4b. AI voiceover: TTS the hook, then prepend a branded narrated intro card ---
export async function synthSpeech(text, voice) {
  const ttsT0 = Date.now();
  aiLog(`  🤖 TTS (gpt-4o-mini-tts, voice "${voice || "alloy"}"): ${text.length} chars, ` +
        `~$${((text.length / 1000) * PRICE.ttsPer1k).toFixed(4)}`);
  const res = await openai().audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: voice || "alloy",
    input: text,
  });
  return Buffer.from(await res.arrayBuffer());
}

async function generateVoiceover(text, outPath, voice) {
  await fs.writeFile(outPath, await synthSpeech(text, voice));
}

async function addNarratedIntro(baseClip, clip, index, workDir, resolution, voice, log) {
  const hook = (clip.hook || clip.title || "").trim();
  if (!hook) return baseClip;
  const { W, H } = dims(resolution);

  log(`  generating AI voiceover for clip ${index + 1}…`);
  const voMp3 = path.join(workDir, `vo_${index + 1}.mp3`);
  await generateVoiceover(hook, voMp3, voice);

  const voDur = await probeDurationSec(voMp3);
  const dur = Math.min(8, Math.max(1.5, voDur + 0.5));

  // Wrap the hook into short lines so it fits the card (drawtext has no auto-wrap).
  const wrapped = hook
    .replace(/'/g, "’").replace(/:/g, " ")
    .replace(/(.{1,22})(\s+|$)/g, "$1\n").trim();
  const fontsize = Math.round(W / 15);

  const intro = path.join(workDir, `intro_${index + 1}.mp4`);
  const introArgs = [
    "-y",
    "-f", "lavfi", "-i", `color=c=0x0b1020:s=${W}x${H}:d=${dur}`,
    "-i", voMp3,
  ];
  if (await hasDrawtext()) {
    introArgs.push("-vf", `drawtext=text='${wrapped}':fontcolor=white:fontsize=${fontsize}:x=(w-text_w)/2:y=(h-text_h)/2:line_spacing=14`);
  }
  introArgs.push(
    "-r", "30", "-pix_fmt", "yuv420p",
    "-c:v", "libx264", "-preset", "veryfast",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
    "-shortest", intro,
  );
  await run(FFMPEG, introArgs);

  // Concat (re-encode) intro + clip into the final narrated short.
  const final = path.join(workDir, `final_${index + 1}.mp4`);
  await run(FFMPEG, [
    "-y", "-i", intro, "-i", baseClip,
    "-filter_complex", "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]",
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
    final,
  ]);
  return final;
}

// --- orchestrator: run the whole pipeline for one URL ---
// opts: { maxClips, resolution, voiceover, voice }
export async function makeClips(url, log = () => {}, opts = {}) {
  const maxClips = opts.maxClips || MAX_CLIPS;
  const resolution = opts.resolution || 1080;
  const wantVoiceover = !!opts.voiceover;
  const voice = opts.voice || "alloy";
  const caption = opts.caption || { style: "bold", position: "top", size: "medium" };
  const lengthPref = opts.length || "auto";
  const range = opts.range || null; // { start, end } seconds, or null for the whole video
  const motion = ["none", "subtle", "strong"].includes(opts.motion) ? opts.motion : "subtle";
  // Reports the current phase so the UI can show a real progress bar instead
  // of raw tool output. pct is an overall 0-100 estimate.
  const progress = opts.onProgress || (() => {});

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "makeitreel-"));
  try {
    progress("download", 5);

    // Two-phase for link sources: grab audio now, and only the chosen moments
    // as video later. Uploads and direct media are already cheap/local, so they
    // keep the simple whole-file path.
    const normalized = opts.sourceFile ? null : normalizeUrl(url).url;
    const twoPhase = !opts.sourceFile && !opts.externalDownload && normalized && !isDirectMedia(normalized);

    let video = null;      // full media, when we have it
    let analysisFile;      // what we transcribe

    if (opts.sourceFile) {
      log("Using your uploaded video…");
      video = analysisFile = opts.sourceFile;
    } else if (opts.externalDownload) {
      // A home helper fetches the whole file for us; no two-phase needed since
      // it isn't our bandwidth being metered.
      video = analysisFile = await opts.externalDownload(url, workDir, log);
      log("Received the video from your download helper.");
    } else if (twoPhase) {
      analysisFile = await downloadAudioOnly(url, workDir, log, range);
    } else {
      video = analysisFile = await downloadVideo(url, workDir, log);
    }

    // Whole-file sources may be audio-only (podcasts) -> audiogram rendering.
    // In two-phase mode we fetch real video per section, so it's never audio-only.
    const isAudioOnly = twoPhase ? false : !(await hasVideoStream(video));
    if (isAudioOnly) log("Audio-only source — clips will be rendered as audiograms.");

    progress("transcribe", 30);
    // The audio we downloaded is already trimmed to the range, so don't trim twice;
    // shift its timestamps back onto the source timeline instead.
    let segments, words;
    if (twoPhase) {
      // Audio was already trimmed to the range; shift back onto the source timeline.
      const off = range ? range.start : 0;
      const r = await transcribe(analysisFile, workDir, log, null);
      segments = r.segments.map((x) => ({ ...x, start: x.start + off, end: x.end + off }));
      words = r.words.map((x) => ({ ...x, start: x.start + off, end: x.end + off }));
    } else {
      const r = await transcribe(analysisFile, workDir, log, range);
      segments = r.segments; words = r.words;
    }
    if (!segments.length) throw new Error("No speech found to transcribe.");
    progress("moments", 60);
    const moments = await selectMoments(segments, log, maxClips, lengthPref);

    const results = [];
    for (let i = 0; i < moments.length; i++) {
      progress("render", 70 + Math.round((i / Math.max(1, moments.length)) * 28), {
        current: i + 1, total: moments.length,
      });
      let file;
      if (twoPhase) {
        // Fetch only these seconds, then cut from the start of that section.
        log(`Fetching clip ${i + 1} of ${moments.length} from the source…`);
        const sec = await downloadSection(url, workDir, log, moments[i].start, moments[i].end, i);
        const local = { ...moments[i], start: 0, end: Math.max(1, moments[i].end - moments[i].start) };
        file = await cutClip(sec, local, i, workDir, resolution, caption, log, 
          // shift words to be relative to this section
          words.map((w) => ({ ...w, start: w.start - moments[i].start, end: w.end - moments[i].start })), motion);
      } else if (isAudioOnly) {
        file = await cutAudiogram(video, moments[i], i, workDir, resolution, caption, log);
      } else {
        file = await cutClip(video, moments[i], i, workDir, resolution, caption, log, words, motion);
      }
      let narrated = false;
      if (wantVoiceover) {
        try {
          file = await addNarratedIntro(file, moments[i], i, workDir, resolution, voice, log);
          narrated = true;
        } catch (e) {
          // Never let a voiceover failure kill the clip — ship it without narration.
          log(`  voiceover failed for clip ${i + 1} (${e.message}) — keeping clip without narration.`);
        }
      }
      results.push({
        file,
        title: moments[i].title,
        hook: moments[i].hook,
        virality: moments[i].virality ?? null,
        start: moments[i].start,
        end: moments[i].end,
        narrated,
      });
    }
    progress("done", 100);
    log("Done! Clips are ready.");
    return { workDir, clips: results };
  } catch (err) {
    log("Error: " + err.message);
    throw err;
  }
}
