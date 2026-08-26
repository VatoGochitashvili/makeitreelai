#!/usr/bin/env node
// MakeItReel download helper.
//
// Run this on a normal home computer. It asks your server whether anything
// needs downloading, fetches it with yt-dlp over your own (residential)
// connection — which YouTube trusts — and sends the file back.
//
//   SERVER_URL=https://your-app.onrender.com \
//   WORKER_TOKEN=the-same-secret-as-the-server \
//   node worker.js
//
// It only makes outbound requests, so nothing on your machine is exposed.

import { spawn } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVER = (process.env.SERVER_URL || "http://localhost:3000").replace(/\/$/, "");
const TOKEN = process.env.WORKER_TOKEN;
const POLL_MS = Number(process.env.WORKER_POLL_MS || 5000);

if (!TOKEN) {
  console.error("✗ Set WORKER_TOKEN to the same value as your server's WORKER_TOKEN.");
  process.exit(1);
}
if (/your-app\.onrender\.com/.test(SERVER)) {
  console.error("✗ SERVER_URL is still the example value.\n" +
    "  Point it at your own site, e.g.\n" +
    "    SERVER_URL=https://makeitreelai.onrender.com WORKER_TOKEN=... npm run worker\n" +
    "  or for local testing:\n" +
    "    SERVER_URL=http://localhost:3000 WORKER_TOKEN=... npm run worker");
  process.exit(1);
}
if (!process.env.SERVER_URL) {
  console.log("! SERVER_URL not set — defaulting to http://localhost:3000\n");
}

const headers = { "x-worker-token": TOKEN };

function runYtdlp(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("yt-dlp", args);
    let err = "";
    p.stdout.on("data", (d) => process.stdout.write("  " + d.toString()));
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-400) || `yt-dlp exited ${code}`))));
  });
}

// YouTube refuses its player clients unevenly — a video that 403s on one is
// often served fine by another. Same fallback the server uses.
const CLIENTS = (process.env.YTDLP_CLIENTS
  || "default,tv,ios,mweb,web_embedded,tv_embedded,android").split(",").map((c) => c.trim()).filter(Boolean);

async function ytdlp(url, out) {
  let lastErr;
  for (const client of CLIENTS) {
    const args = [
      "--no-warnings", "--no-playlist",
      "--retries", "5", "--extractor-retries", "5", "--sleep-requests", "1",
      "-f", "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      "--merge-output-format", "mp4",
      "-o", out, url,
    ];
    if (client !== "default") args.push("--extractor-args", `youtube:player_client=${client}`);
    if (process.env.YTDLP_COOKIES) args.push("--cookies", process.env.YTDLP_COOKIES);

    try {
      await runYtdlp(args);
      if (client !== "default") console.log(`  (worked with the "${client}" player)`);
      return;
    } catch (e) {
      lastErr = e;
      // A private/deleted/DRM video fails the same way everywhere — don't grind.
      if (!/403|Forbidden|Sign in to confirm|not a bot|429|Requested format|unable to download/i.test(e.message)) break;
      console.log(`  "${client}" refused — trying another player…`);
      await fs.rm(out, { force: true }).catch(() => {});
    }
  }
  throw lastErr || new Error("Download failed.");
}

async function handle(job) {
  console.log(`\n▶ Downloading ${job.url}`);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mir-worker-"));
  const out = path.join(dir, "source.mp4");
  try {
    await ytdlp(job.url, out);
    const { size } = await fs.stat(out);
    console.log(`  uploading ${(size / 1e6).toFixed(1)} MB back to the server…`);

    const res = await fetch(`${SERVER}/api/worker/deliver/${job.id}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/octet-stream", "content-length": String(size) },
      body: createReadStream(out),
      duplex: "half", // required when streaming a request body
    });
    console.log(res.ok ? "  ✓ delivered" : `  ✗ server said ${res.status}`);
  } catch (e) {
    console.log(`  ✗ ${e.message.split("\n").pop()}`);
    await fetch(`${SERVER}/api/worker/fail/${job.id}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ error: e.message.slice(-300) }),
    }).catch(() => {});
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// An out-of-date yt-dlp is the single most common cause of sudden 403s,
// because YouTube changes and yt-dlp ships fixes within days.
async function reportYtdlpVersion() {
  await new Promise((resolve) => {
    const p = spawn("yt-dlp", ["--version"]);
    let v = "";
    p.stdout.on("data", (d) => (v += d.toString()));
    p.on("error", () => { console.log("! yt-dlp not found on PATH — install it (brew install yt-dlp)"); resolve(); });
    p.on("close", () => {
      const ver = v.trim();
      if (ver) console.log(`yt-dlp ${ver}  (if downloads start failing with 403, run: brew upgrade yt-dlp)`);
      resolve();
    });
  });
}
await reportYtdlpVersion();

console.log(`MakeItReel download helper → ${SERVER}`);
console.log("Leave this running. Press Ctrl+C to stop.\n");

let warned = false;
for (;;) {
  try {
    const r = await fetch(`${SERVER}/api/worker/next`, { headers });
    if (r.status === 401) {
      console.error("✗ Server rejected the token — check WORKER_TOKEN matches.");
      process.exit(1);
    }
    const job = await r.json();
    if (job && job.id) await handle(job);
    else process.stdout.write(".");           // idle heartbeat
    fetch(`${SERVER}/api/worker/ping`, { headers }).catch(() => {});
    warned = false;
  } catch (e) {
    if (!warned) {
      console.log(`\n… can't reach ${SERVER} — is that the right address, and is the site up? (retrying)`);
      warned = true;
    }
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
