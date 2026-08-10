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
import { createReadStream } from "node:fs";

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

// --- small helper: read a media file's duration in seconds via ffprobe ---
function probeDurationSec(file) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", [
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

// Some ffmpeg builds ship without libfreetype (no `drawtext` filter). Detect
// once so we can burn captions when possible and skip them gracefully if not.
let _drawtext;
function hasDrawtext() {
  if (_drawtext !== undefined) return Promise.resolve(_drawtext);
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-filters"]);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", () => resolve((_drawtext = false)));
    p.on("close", () => resolve((_drawtext = /\bdrawtext\b/.test(out))));
  });
}

// Whisper rejects uploads over 25MB; stay safely under it.
const WHISPER_LIMIT_BYTES = 24 * 1024 * 1024;
// At 64kbps mono a 15-min chunk is ~7MB — comfortably under the limit.
const TRANSCRIBE_CHUNK_SEC = 15 * 60;

// Send one audio file to Whisper and return its segments.
async function transcribeFile(file) {
  const res = await openai().audio.transcriptions.create({
    file: createReadStream(file),
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
  });
  return res.segments || [];
}

// --- 1. download the source video ---
async function downloadVideo(url, workDir, log) {
  log("Downloading video…");
  const out = path.join(workDir, "source.mp4");
  // -f best mp4, limit to 1080p to keep files sane
  await run("yt-dlp", [
    "-f", "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
    "--merge-output-format", "mp4",
    "-o", out,
    url,
  ], { onLog: (l) => log(l.trim()) });
  return out;
}

// --- 2. transcribe with timestamps (Whisper) ---
async function transcribe(videoPath, workDir, log) {
  log("Transcribing audio…");
  // extract a compressed audio track first (smaller upload, cheaper)
  const audio = path.join(workDir, "audio.mp3");
  await run("ffmpeg", ["-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", audio]);

  const size = (await fs.stat(audio)).size;

  // Short enough for a single upload.
  if (size <= WHISPER_LIMIT_BYTES) {
    return await transcribeFile(audio); // [{ start, end, text }, ...]
  }

  // Long podcasts exceed Whisper's 25MB limit — split into time chunks,
  // transcribe each, and shift every segment back onto the full timeline.
  const dur = await probeDurationSec(audio);
  const nChunks = Math.ceil(dur / TRANSCRIBE_CHUNK_SEC);
  log(`Audio is ${(size / 1e6).toFixed(0)}MB (over Whisper's 25MB limit) — transcribing in ${nChunks} chunks…`);

  const segments = [];
  for (let i = 0; i < nChunks; i++) {
    const start = i * TRANSCRIBE_CHUNK_SEC;
    const chunk = path.join(workDir, `chunk_${i}.mp3`);
    // -ss before -i seeks by input; -c copy keeps it fast and lossless.
    await run("ffmpeg", ["-y", "-ss", String(start), "-t", String(TRANSCRIBE_CHUNK_SEC), "-i", audio, "-c", "copy", chunk]);

    // A tiny trailing remainder can be effectively empty — skip it.
    if ((await fs.stat(chunk)).size < 3000) continue;

    log(`  transcribing chunk ${i + 1}/${nChunks}…`);
    const segs = await transcribeFile(chunk);
    for (const s of segs) {
      segments.push({ ...s, start: s.start + start, end: s.end + start });
    }
  }
  return segments;
}

// --- 3. ask the LLM to pick the best clip-worthy moments ---
async function selectMoments(segments, log, maxClips = MAX_CLIPS) {
  log("AI is finding the best moments…");
  // Build a compact timestamped transcript for the model
  const transcript = segments
    .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text.trim()}`)
    .join("\n");

  const prompt = `You are an expert short-form video editor. Below is a timestamped transcript of a long video.
Pick the ${maxClips} BEST standalone moments to turn into vertical short clips (15-60 seconds each).
Prefer strong hooks, punchlines, surprising insights, emotional or quotable lines.
Each clip must start and end on a natural sentence boundary.

Return ONLY valid JSON in this exact shape:
{"clips":[{"start":<seconds>,"end":<seconds>,"title":"<catchy title>","hook":"<the opening line>","virality":<1-100>}]}

Transcript:
${transcript}`;

  const completion = await openai().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0.4,
  });

  let data;
  try {
    data = JSON.parse(completion.choices[0].message.content);
  } catch {
    throw new Error("AI returned invalid JSON while selecting moments.");
  }
  const clips = (data.clips || [])
    .filter((c) => typeof c.start === "number" && typeof c.end === "number" && c.end > c.start)
    .slice(0, maxClips);
  log(`AI selected ${clips.length} moments.`);
  return clips;
}

// 9:16 dimensions for a given target resolution (long edge height).
function dims(resolution) {
  return resolution >= 1080 ? { W: 1080, H: 1920 } : { W: 720, H: 1280 };
}

// --- 4. cut each moment into a vertical 9:16 clip with a title caption ---
async function cutClip(videoPath, clip, index, workDir, resolution, log) {
  const out = path.join(workDir, `clip_${index + 1}.mp4`);
  const dur = Math.max(1, clip.end - clip.start);
  const { W, H } = dims(resolution);
  const fontsize = Math.round(W / 20); // ~54 @1080, ~36 @720

  // Escape the title for ffmpeg drawtext
  const title = (clip.title || "").replace(/'/g, "’").replace(/:/g, " ").slice(0, 60);

  // Filter: scale up, crop center to 9:16, then (if supported) draw the title.
  // Normalize fps/pixfmt/audio so clips can be safely concatenated with an intro.
  // Scale to COVER the 9:16 frame (works for landscape or portrait sources),
  // then center-crop. Scaling only the width broke on landscape videos.
  const filters = [
    `scale=${W}:${H}:force_original_aspect_ratio=increase`,
    `crop=${W}:${H}`,
  ];
  if (await hasDrawtext()) {
    filters.push(`drawtext=text='${title}':fontcolor=white:fontsize=${fontsize}:box=1:boxcolor=black@0.5:boxborderw=18:x=(w-text_w)/2:y=${Math.round(H * 0.073)}:line_spacing=8`);
  } else if (index === 0) {
    log("Note: this ffmpeg build has no 'drawtext' filter — clips will render without burned-in captions.");
  }
  const vf = filters.join(",");

  log(`Cutting clip ${index + 1} @${H}p: "${clip.title || "untitled"}"…`);
  await run("ffmpeg", [
    "-y",
    "-ss", String(clip.start),
    "-i", videoPath,
    "-t", String(dur),
    "-vf", vf,
    "-r", "30", "-pix_fmt", "yuv420p",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
    out,
  ]);
  return out;
}

// --- 4b. AI voiceover: TTS the hook, then prepend a branded narrated intro card ---
async function generateVoiceover(text, outPath, voice) {
  const res = await openai().audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: voice || "alloy",
    input: text,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(outPath, buf);
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
  await run("ffmpeg", introArgs);

  // Concat (re-encode) intro + clip into the final narrated short.
  const final = path.join(workDir, `final_${index + 1}.mp4`);
  await run("ffmpeg", [
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

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "makeitreel-"));
  try {
    const video = await downloadVideo(url, workDir, log);
    const segments = await transcribe(video, workDir, log);
    if (!segments.length) throw new Error("No speech found to transcribe.");
    const moments = await selectMoments(segments, log, maxClips);

    const results = [];
    for (let i = 0; i < moments.length; i++) {
      let file = await cutClip(video, moments[i], i, workDir, resolution, log);
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
    log("Done! Clips are ready.");
    return { workDir, clips: results };
  } catch (err) {
    log("Error: " + err.message);
    throw err;
  }
}
