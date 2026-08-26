// Background footage for "brainrot"-style shorts.
//
// The format is a wall of gameplay (Minecraft parkour, Fortnite, a subway
// runner) under a narrated voiceover. We can't ship that footage — it belongs
// to whoever recorded it — so this is a library the user fills themselves:
// drop files in assets/backgrounds/, or upload them from the Studio.
//
// Anything uploaded is stored per-user; anything in assets/ is shared by all.

import { Router } from "express";
import { randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { probeDurationSec, hasVideoStream } from "./pipeline.js";

const ROOT = process.cwd();
const BUNDLED_DIR = path.join(ROOT, "assets", "backgrounds");
const DATA_DIR = path.join(ROOT, ".data");
const USER_DIR = path.join(DATA_DIR, "backgrounds");
const INDEX_FILE = path.join(DATA_DIR, "backgrounds.json");

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv)$/i;
const MAX_BG_MB = 400;

let index = [];   // [{ id, name, file, duration, userId|null, at }]

async function persist() {
  await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  await fs.writeFile(INDEX_FILE, JSON.stringify(index, null, 2)).catch(() => {});
}

// Files dropped straight into assets/backgrounds/ should just work, with no
// upload step — that's the easiest way to seed a library.
async function scanBundled() {
  let names = [];
  try { names = await fs.readdir(BUNDLED_DIR); } catch { return []; }
  const found = [];
  for (const n of names.filter((n) => VIDEO_EXT.test(n))) {
    const file = path.join(BUNDLED_DIR, n);
    let duration = null;
    try { duration = await probeDurationSec(file); } catch { /* unreadable */ }
    found.push({
      id: "bundled:" + n,
      name: n.replace(VIDEO_EXT, "").replace(/[-_]+/g, " "),
      file, duration, userId: null, at: 0,
    });
  }
  return found;
}

export async function loadBackgrounds() {
  await fs.mkdir(USER_DIR, { recursive: true }).catch(() => {});
  let saved = [];
  try { saved = JSON.parse(await fs.readFile(INDEX_FILE, "utf8")); } catch { /* first run */ }
  // Drop entries whose file went missing (a manual clean-up, a redeploy).
  const alive = [];
  for (const b of saved) {
    if (await fs.access(b.file).then(() => true, () => false)) alive.push(b);
  }
  index = [...(await scanBundled()), ...alive];
  if (alive.length !== saved.length) await persist();
  return index;
}

// What this user can pick from: the shared library plus their own uploads.
export function backgroundsFor(userId) {
  return index.filter((b) => b.userId == null || b.userId === userId);
}

export function findBackground(id, userId) {
  return backgroundsFor(userId).find((b) => b.id === id) || null;
}

export function anyBackground(userId) {
  const list = backgroundsFor(userId);
  return list.length ? list[Math.floor(Math.random() * list.length)] : null;
}

export const backgroundsRouter = Router();

backgroundsRouter.get("/backgrounds", (req, res) => {
  const list = backgroundsFor(req.user?.id).map(({ file, ...rest }) => rest);
  res.json({ backgrounds: list });
});

// Raw-body upload, matching /api/upload — no multipart dependency.
backgroundsRouter.post("/backgrounds", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please log in to add background footage." });

  const maxBytes = MAX_BG_MB * 1024 * 1024;
  const declared = Number(req.headers["content-length"] || 0);
  if (declared && declared > maxBytes) {
    return res.status(413).json({ error: `Background clips are capped at ${MAX_BG_MB} MB.` });
  }

  const name = String(req.query.name || "gameplay.mp4").replace(/[^\w.\- ]/g, "_").slice(-80);
  if (!VIDEO_EXT.test(name)) {
    return res.status(400).json({ error: "Use an mp4, mov, webm or mkv video." });
  }

  const id = randomUUID();
  const file = path.join(USER_DIR, id + (name.match(VIDEO_EXT) || [".mp4"])[0]);
  const out = createWriteStream(file);

  let written = 0, aborted = false;
  const fail = async (code, msg) => {
    if (aborted) return;
    aborted = true;
    req.unpipe(out); out.destroy();
    await fs.rm(file, { force: true }).catch(() => {});
    if (!res.headersSent) res.status(code).json({ error: msg });
  };
  req.on("data", (c) => {
    written += c.length;
    if (written > maxBytes) fail(413, `Background clips are capped at ${MAX_BG_MB} MB.`);
  });
  req.on("aborted", () => fail(499, "Upload cancelled."));
  out.on("error", () => fail(500, "Could not save that file."));
  req.pipe(out);

  out.on("finish", async () => {
    if (aborted) return;
    if (!written) return fail(400, "The upload was empty.");
    // Footage with no picture would render a black screen — say so now.
    if (!(await hasVideoStream(file).catch(() => false))) {
      return fail(400, "That file has no video track.");
    }
    let duration = null;
    try { duration = await probeDurationSec(file); } catch { /* unknown */ }
    const entry = {
      id, name: name.replace(VIDEO_EXT, ""), file, duration,
      userId: req.user.id, at: Date.now(),
    };
    index.push(entry);
    await persist();
    const { file: _f, ...safe } = entry;
    res.json({ background: safe });
  });
});

backgroundsRouter.delete("/backgrounds/:id", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please log in." });
  const i = index.findIndex((b) => b.id === req.params.id && b.userId === req.user.id);
  if (i === -1) return res.status(404).json({ error: "Not found." });
  const [gone] = index.splice(i, 1);
  await fs.rm(gone.file, { force: true }).catch(() => {});
  await persist();
  res.json({ ok: true });
});
