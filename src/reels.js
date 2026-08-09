// "My Reels" — each user's library of generated clips.
// Clip files live on disk under public/clips/<jobId>/ (served at /clips/...),
// so we only persist the metadata here. Survives restarts via the JSON store.

import { Router } from "express";
import { randomUUID } from "node:crypto";
import { readJSON, writeJSON } from "./store.js";

const library = readJSON("reels.json", {}); // userId -> [ { id, url, title, hook, virality, narrated, sourceUrl, createdAt } ]
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

reelsRouter.delete("/reels/:id", (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please log in." });
  const list = library[req.user.id] || [];
  const i = list.findIndex((r) => r.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "Not found." });
  list.splice(i, 1);
  persist();
  res.json({ ok: true });
});
