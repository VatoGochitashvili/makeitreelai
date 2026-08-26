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
