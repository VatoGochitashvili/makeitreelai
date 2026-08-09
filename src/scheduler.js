// Auto-post scheduler — MakeItReel's differentiator vs Opus.
// Lets Creator/Pro users queue finished clips to TikTok / Instagram / YouTube.
// In-memory for the MVP (swap for a DB with the accounts later).
//
// NOTE: actual publishing to the platforms needs each network's API connection
// (TikTok Content Posting API, Instagram Graph API, YouTube Data API) plus the
// user linking their account via OAuth. Until those are connected, due posts are
// flipped to "posted" locally so the queue is fully demonstrable.

import { Router } from "express";
import { randomUUID } from "node:crypto";
import { planOf } from "./plans.js";
import { readJSON, writeJSON } from "./store.js";

const posts = readJSON("schedule.json", []); // { id, userId, clipUrl, title, platform, when, status, createdAt }
const PLATFORMS = new Set(["tiktok", "instagram", "youtube"]);
function persist() { writeJSON("schedule.json", () => posts); }

export const schedulerRouter = Router();

schedulerRouter.get("/schedule", (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please log in." });
  const mine = posts
    .filter((p) => p.userId === req.user.id)
    .sort((a, b) => a.when - b.when);
  res.json({ posts: mine });
});

schedulerRouter.post("/schedule", (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please log in." });
  const plan = planOf(req.user.plan);
  if (!plan.scheduler) {
    return res.status(403).json({
      error: "The auto-post scheduler is a Creator/Pro feature. Upgrade to enable it.",
      upgrade: true,
    });
  }
  const { clipUrl, title, platform, when } = req.body || {};
  if (!clipUrl) return res.status(400).json({ error: "A clip URL is required." });
  if (!PLATFORMS.has(platform)) return res.status(400).json({ error: "Pick a valid platform." });
  // Must have linked that platform account.
  if (!req.user.connections || !req.user.connections[platform]) {
    return res.status(400).json({ error: `Connect your ${platform} account first.`, connect: platform });
  }
  const ts = Date.parse(when);
  if (!ts || Number.isNaN(ts)) return res.status(400).json({ error: "Pick a valid date & time." });

  const post = {
    id: randomUUID(),
    userId: req.user.id,
    clipUrl,
    title: (title || "Untitled clip").slice(0, 120),
    platform,
    when: ts,
    status: "scheduled",
    createdAt: Date.now(),
  };
  posts.push(post);
  persist();
  res.status(201).json({ post });
});

schedulerRouter.delete("/schedule/:id", (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please log in." });
  const i = posts.findIndex((p) => p.id === req.params.id && p.userId === req.user.id);
  if (i === -1) return res.status(404).json({ error: "Not found." });
  posts.splice(i, 1);
  persist();
  res.json({ ok: true });
});

// Simulated publisher: flip due posts to "posted". Replace with real platform API
// calls once accounts are linked.
const tick = setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const p of posts) if (p.status === "scheduled" && p.when <= now) { p.status = "posted"; changed = true; }
  if (changed) persist();
}, 15000);
tick.unref?.();
