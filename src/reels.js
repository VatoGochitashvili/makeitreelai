// "My Reels" — each user's library of generated clips.
// Clip files live on disk under public/clips/<jobId>/ (served at /clips/...),
// so we only persist the metadata here. Survives restarts via the JSON store.

import { Router } from "express";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJSON, writeJSON } from "./store.js";

const CLIPS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "clips");

// Turn "/clips/<job>/clip_1.mp4" into a real path, refusing anything that
// escapes the clips directory.
function resolveClip(url) {
  if (!url || !url.startsWith("/clips/")) return null;
  const abs = path.resolve(CLIPS_DIR, "." + url.slice("/clips".length));
  return abs.startsWith(path.resolve(CLIPS_DIR) + path.sep) ? abs : null;
}

// Remove a clip's file, and the job folder once it's empty.
async function deleteClipFile(url) {
  const file = resolveClip(url);
  if (!file) return 0;
  let freed = 0;
  try {
    freed = (await fs.stat(file)).size;
    await fs.rm(file, { force: true });
    const dir = path.dirname(file);
    const left = await fs.readdir(dir).catch(() => ["keep"]);
    if (!left.length) await fs.rmdir(dir).catch(() => {});
  } catch { /* already gone */ }
  return freed;
}

const library = readJSON("reels.json", {}); // userId -> [ { id, url, title, hook, virality, narrated, format, sourceUrl, createdAt } ]
function persist() { writeJSON("reels.json", () => library); }

// Save a finished batch of clips to a user's library.
export function addReels(userId, clips, sourceUrl) {
  if (!userId || !Array.isArray(clips) || !clips.length) return;
  const now = Date.now();
  const list = library[userId] || (library[userId] = []);
  for (const c of clips) {
    list.push({
      id: randomUUID(),
      url: c.url, title: c.title, hook: c.hook,
      virality: c.virality, narrated: !!c.narrated,
      format: c.format || "clip",
      sourceUrl: sourceUrl || null, createdAt: now,
    });
  }
  persist();
}

// ---------- retention ----------
// Clips are big — a single run can leave a few hundred MB behind, and nothing
// was ever deleting them. Left alone this fills the disk and takes the site
// down, so old clips are swept on a schedule and their library rows go with
// them (a row pointing at a missing file is worse than no row).
const RETENTION_DAYS = Number(process.env.CLIP_RETENTION_DAYS || 30);
export const retentionDays = () => RETENTION_DAYS;

export async function sweepOldClips() {
  if (!(RETENTION_DAYS > 0)) return { removed: 0, freed: 0 };
  const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
  let removed = 0, freed = 0;

  // 1. Drop expired rows, freeing their files.
  for (const [userId, list] of Object.entries(library)) {
    const keep = [];
    for (const reel of list) {
      if (reel.createdAt && reel.createdAt < cutoff) {
        freed += await deleteClipFile(reel.url);
        removed++;
      } else keep.push(reel);
    }
    library[userId] = keep;
  }
  if (removed) persist();

  // 2. Sweep job folders nothing references — failed runs, deleted accounts,
  //    anything orphaned by a crash between rendering and saving.
  const referenced = new Set(
    Object.values(library).flat().map((r) => path.dirname(resolveClip(r.url) || "")).filter(Boolean)
  );
  const dirs = await fs.readdir(CLIPS_DIR, { withFileTypes: true }).catch(() => []);
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(CLIPS_DIR, d.name);
    if (referenced.has(dir)) continue;
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat || stat.mtimeMs > cutoff) continue;   // young orphans may still be in flight
    for (const f of await fs.readdir(dir).catch(() => [])) {
      const st = await fs.stat(path.join(dir, f)).catch(() => null);
      if (st) freed += st.size;
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    removed++;
  }
  return { removed, freed };
}

export function startRetentionSweep(log = () => {}) {
  const run = () => sweepOldClips().then(({ removed, freed }) => {
    if (removed) log(`Cleaned up ${removed} expired clip${removed === 1 ? "" : "s"} (${(freed / 1e6).toFixed(0)} MB freed).`);
  }).catch(() => {});
  const t = setInterval(run, 6 * 60 * 60 * 1000);
  t.unref?.();
  setTimeout(run, 10_000).unref?.();
}

export const reelsRouter = Router();

reelsRouter.get("/reels", (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please log in." });
  const list = (library[req.user.id] || []).slice().sort((a, b) => b.createdAt - a.createdAt);
  res.json({ reels: list });
});

reelsRouter.delete("/reels/:id", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please log in." });
  const list = library[req.user.id] || [];
  const i = list.findIndex((r) => r.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "Not found." });

  const [removed] = list.splice(i, 1);
  persist();
  // Actually reclaim the disk — removing the row alone left the file behind.
  const freed = await deleteClipFile(removed.url);
  res.json({ ok: true, freedBytes: freed });
});

// Delete every clip in the library at once.
reelsRouter.delete("/reels", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please log in." });
  const list = library[req.user.id] || [];
  let freed = 0;
  for (const r of list) freed += await deleteClipFile(r.url);
  library[req.user.id] = [];
  persist();
  res.json({ ok: true, removed: list.length, freedBytes: freed });
});

// How much space the library is using.
reelsRouter.get("/reels/usage", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please log in." });
  const list = library[req.user.id] || [];
  let bytes = 0;
  for (const r of list) {
    const f = resolveClip(r.url);
    if (f) bytes += await fs.stat(f).then((st) => st.size).catch(() => 0);
  }
  res.json({ clips: list.length, bytes });
});
