// Podcast autopilot — the loop Opus doesn't close.
//
// A creator connects their show's RSS feed once. From then on, every new
// episode is clipped and queued to post without anyone opening the site.
// Clip tools stop at "here are your clips"; the actual job is being on TikTok
// five times a week, forever, and that's the part this automates.
//
// Deliberately conservative about money: one episode per check, the newest
// only, and every run still counts against the plan's monthly quota.

import { Router } from "express";
import { randomUUID } from "node:crypto";
import { fetchPodcastFeed } from "./sources.js";
import { readJSON, writeJSON } from "./store.js";
import { planOf } from "./plans.js";
import { getUsage } from "./auth.js";

// userId -> { id, userId, feedUrl, show, artwork, settings, active,
//             seen: [episodeUrl], lastCheck, lastError, history: [...] }
const feeds = readJSON("autopilot.json", []);
function persist() { writeJSON("autopilot.json", () => feeds); }

const CHECK_EVERY_MS = 30 * 60 * 1000;   // podcasts drop on a schedule; 30 min is plenty
const MAX_HISTORY = 40;

// An episode identifies itself by its media URL — titles get edited, URLs don't.
const idOf = (ep) => ep.url;

export function feedFor(userId) {
  return feeds.find((f) => f.userId === userId) || null;
}

// ---------- the loop ----------
// Injected rather than imported, because server.js imports this module and a
// cycle would leave one of them half-initialised at load time.
let deps = null;
export function initAutopilot({ startJob, findUser, schedulePost }) {
  deps = { startJob, findUser, schedulePost };
  const timer = setInterval(() => { checkAll().catch(() => {}); }, CHECK_EVERY_MS);
  timer.unref?.();
  // A first pass shortly after boot, so a restart doesn't miss an episode by
  // half an hour — but not instantly, so startup isn't competing for CPU.
  const first = setTimeout(() => { checkAll().catch(() => {}); }, 60 * 1000);
  first.unref?.();
}

function note(feed, msg, extra = {}) {
  feed.history.unshift({ at: Date.now(), msg, ...extra });
  feed.history.length = Math.min(feed.history.length, MAX_HISTORY);
}

export async function checkAll() {
  for (const feed of feeds) {
    if (!feed.active) continue;
    try {
      await checkFeed(feed);
    } catch (e) {
      feed.lastError = e.message;
      note(feed, `Couldn't read the feed: ${e.message}`, { kind: "error" });
    }
    feed.lastCheck = Date.now();
  }
  persist();
}

export async function checkFeed(feed) {
  const user = deps.findUser(feed.userId);
  if (!user) return;

  const { show, artwork, episodes } = await fetchPodcastFeed(feed.feedUrl, 20);
  feed.show = show || feed.show;
  feed.artwork = artwork || feed.artwork;
  feed.lastError = null;

  // First sync marks everything as seen: connecting a feed shouldn't spend a
  // month's quota clipping the back catalogue.
  if (!feed.primed) {
    feed.seen = episodes.map(idOf);
    feed.primed = true;
    note(feed, `Connected to "${feed.show}" — watching for new episodes.`);
    return;
  }

  const fresh = episodes.filter((ep) => !feed.seen.includes(idOf(ep)));
  if (!fresh.length) return;

  // Newest only, one per check. If three land at once the others get picked up
  // on later passes rather than firing three concurrent runs.
  const ep = fresh[0];
  feed.seen.unshift(idOf(ep));
  feed.seen.length = Math.min(feed.seen.length, 200);

  const plan = planOf(user.plan);
  const usage = getUsage(user);
  if (plan.videosPerMonth !== -1 && usage.videos >= plan.videosPerMonth) {
    note(feed, `New episode "${ep.title}" — but this month's quota is used up.`, { kind: "error" });
    return;
  }

  const jobId = deps.startJob(user, {
    url: ep.url,
    auto: true,
    label: ep.title,
    maxClips: feed.settings.clips,
    voiceover: feed.settings.voiceover,
    voice: feed.settings.voice,
    caption: feed.settings.caption,
    length: feed.settings.length,
    motion: "subtle",
    layout: "crop",
    format: "clip",
    range: null,
    onDone: (clips) => onEpisodeClipped(feed, ep, clips),
  });

  note(feed, `New episode "${ep.title}" — generating clips…`, { kind: "start", jobId });
  persist();
}

// Clips are ready: space them out across the days ahead rather than dumping
// ten posts at once, which reads as spam to both the algorithm and the viewer.
async function onEpisodeClipped(feed, ep, clips) {
  note(feed, `"${ep.title}" produced ${clips.length} clip${clips.length === 1 ? "" : "s"}.`, { kind: "done" });

  const platforms = feed.settings.platforms || [];
  if (!platforms.length || !feed.settings.autoPost) { persist(); return; }

  let queued = 0, blocked = null;
  for (let i = 0; i < clips.length; i++) {
    const when = slotFor(feed, i);
    for (const platform of platforms) {
      const r = await deps.schedulePost(feed.userId, {
        clipUrl: clips[i].url, title: clips[i].title, platform, when,
      });
      if (r.ok) queued++;
      else blocked = r.error;
    }
  }
  if (queued) note(feed, `Queued ${queued} post${queued === 1 ? "" : "s"} across ${platforms.join(", ")}.`, { kind: "queued" });
  if (blocked) note(feed, `Couldn't queue every post: ${blocked}`, { kind: "error" });
  persist();
}

// One post per day at the configured hour, starting tomorrow.
function slotFor(feed, index) {
  const hour = feed.settings.postHour ?? 18;
  const d = new Date();
  d.setDate(d.getDate() + 1 + index);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

// ---------- settings a feed runs with ----------
function cleanSettings(raw = {}, plan) {
  const cap = plan.clipsPerVideo;
  return {
    clips: Math.min(cap, Math.max(1, parseInt(raw.clips, 10) || cap)),
    length: ["auto", "short", "medium", "long"].includes(raw.length) ? raw.length : "auto",
    caption: {
      style: ["bold", "highlight", "minimal", "none"].includes(raw.caption?.style) ? raw.caption.style : "bold",
      position: ["top", "center", "bottom"].includes(raw.caption?.position) ? raw.caption.position : "top",
      size: ["small", "medium", "large"].includes(raw.caption?.size) ? raw.caption.size : "medium",
    },
    voiceover: !!raw.voiceover && plan.voiceover,
    voice: typeof raw.voice === "string" ? raw.voice : "alloy",
    autoPost: !!raw.autoPost,
    platforms: Array.isArray(raw.platforms)
      ? raw.platforms.filter((p) => ["tiktok", "instagram", "youtube"].includes(p))
      : [],
    postHour: Math.min(23, Math.max(0, parseInt(raw.postHour, 10) || 18)),
  };
}

export const autopilotRouter = Router();

autopilotRouter.get("/autopilot", (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please log in." });
  const feed = feedFor(req.user.id);
  res.json({ feed: feed || null, enabled: planOf(req.user.plan).scheduler });
});

autopilotRouter.post("/autopilot", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please log in." });
  const plan = planOf(req.user.plan);
  if (!plan.scheduler) {
    return res.status(403).json({
      error: "Autopilot is a Creator/Pro feature. Upgrade to let episodes clip themselves.",
      upgrade: true,
    });
  }

  const { feedUrl, settings, active } = req.body || {};
  let feed = feedFor(req.user.id);

  if (feedUrl && (!feed || feed.feedUrl !== feedUrl)) {
    // Fail now if the feed is unreadable, rather than silently never firing.
    let info;
    try {
      info = await fetchPodcastFeed(feedUrl, 5);
    } catch (e) {
      return res.status(400).json({ error: `Couldn't read that feed: ${e.message}` });
    }
    if (feed) feeds.splice(feeds.indexOf(feed), 1);
    feed = {
      id: randomUUID(), userId: req.user.id, feedUrl,
      show: info.show, artwork: info.artwork,
      settings: cleanSettings(settings, plan),
      active: active !== false,
      seen: [], primed: false, lastCheck: null, lastError: null, history: [],
    };
    feeds.push(feed);
    // Prime immediately so the "watching" state is true the moment they save.
    await checkFeed(feed).catch((e) => { feed.lastError = e.message; });
  } else if (feed) {
    if (settings) feed.settings = cleanSettings(settings, plan);
    if (active != null) feed.active = !!active;
  } else {
    return res.status(400).json({ error: "Paste your podcast's RSS feed URL." });
  }

  persist();
  res.json({ feed });
});

autopilotRouter.delete("/autopilot", (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please log in." });
  const i = feeds.findIndex((f) => f.userId === req.user.id);
  if (i === -1) return res.status(404).json({ error: "Nothing connected." });
  feeds.splice(i, 1);
  persist();
  res.json({ ok: true });
});

// Check right now instead of waiting for the next pass.
autopilotRouter.post("/autopilot/check", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please log in." });
  const feed = feedFor(req.user.id);
  if (!feed) return res.status(404).json({ error: "Nothing connected." });
  try {
    await checkFeed(feed);
    feed.lastCheck = Date.now();
    persist();
    res.json({ feed });
  } catch (e) {
    feed.lastError = e.message;
    persist();
    res.status(400).json({ error: e.message });
  }
});
