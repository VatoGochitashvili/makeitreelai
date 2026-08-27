// The back-catalogue miner.
//
// Every clip tool works on one file at a time. A podcaster with eighty episodes
// therefore has sixty hours of their best thinking sitting in an archive that no
// tool can reach — and a new customer gets nothing until they upload something.
//
// This reads the whole history instead: transcribe every past episode once, find
// the themes the show keeps returning to, then pull the strongest moments on a
// theme from across all of them. "You've talked about burnout in fourteen
// episodes; here are the six best answers you've ever given."
//
// It gets better the longer someone stays, and a one-file-at-a-time competitor
// can't ship it as a feature — they'd need the history.

import { Router } from "express";
import { transcribeSource, textFor } from "./pipeline.js";
import { fetchPodcastFeed } from "./sources.js";
import { readJSON, writeJSON } from "./store.js";
import { planOf } from "./plans.js";
import { feedFor } from "./autopilot.js";
import OpenAI from "openai";

let _openai;
const openai = () => (_openai ||= new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));

// userId -> { episodes: {url: {title, date, duration, segments}}, themes, scan }
const lib = readJSON("catalogue.json", {});
const persist = () => writeJSON("catalogue.json", () => lib);

// A scan is an in-process loop, so a restart kills it. Without this the record
// stays "running" forever and the UI waits for progress that will never come.
for (const m of Object.values(lib)) {
  if (m.scan?.status === "running") {
    m.scan.status = "error";
    m.scan.error = "The server restarted mid-scan. Episodes already read were kept — run it again to continue.";
  }
}

// Whisper is $0.006/min. A 45-minute episode is about 27 cents, so a hundred-
// episode catalogue is real money — always quote it before spending it.
const WHISPER_PER_MIN = 0.006;
const MAX_PER_SCAN = 40;

function mine(userId) {
  return (lib[userId] ||= { episodes: {}, themes: null, scan: null });
}

export function catalogueStats(userId) {
  const m = lib[userId];
  if (!m) return { episodes: 0, minutes: 0, themes: 0 };
  const eps = Object.values(m.episodes);
  return {
    episodes: eps.length,
    minutes: Math.round(eps.reduce((a, e) => a + (e.duration || 0), 0) / 60),
    themes: m.themes ? m.themes.length : 0,
  };
}

// ---------- scanning ----------
async function scanCatalogue(userId, feedUrl, limit) {
  const m = mine(userId);
  m.scan = { status: "running", done: 0, total: 0, current: null, startedAt: Date.now(), error: null };
  persist();
  try {
    const { episodes } = await fetchPodcastFeed(feedUrl, 200);
    const todo = episodes.filter((e) => !m.episodes[e.url]).slice(0, limit);
    m.scan.total = todo.length;
    persist();

    for (const ep of todo) {
      m.scan.current = ep.title;
      persist();
      try {
        const { segments, duration } = await transcribeSource(ep.url);
        // Keep the words, drop everything else — this is a search corpus, not a
        // media library, and full transcripts for 100 episodes stay small.
        m.episodes[ep.url] = {
          title: ep.title, date: ep.date, url: ep.url,
          duration: duration || ep.duration || null,
          segments: segments.map((s) => ({ s: +s.start.toFixed(1), e: +s.end.toFixed(1), t: s.text.trim() })),
        };
      } catch (e) {
        m.episodes[ep.url] = { title: ep.title, url: ep.url, failed: e.message.slice(0, 140) };
      }
      m.scan.done++;
      persist();
    }
    m.scan.status = "done";
    m.scan.current = null;
    m.themes = null;   // the corpus changed, so the themes are stale
  } catch (e) {
    m.scan.status = "error";
    m.scan.error = e.message;
  }
  persist();
}

// ---------- themes ----------
// One pass over every episode's opening minutes is enough to name what a show
// keeps coming back to, and it keeps the prompt inside a sane token budget.
async function findThemes(userId) {
  const m = mine(userId);
  const eps = Object.values(m.episodes).filter((e) => e.segments);
  if (eps.length < 2) throw new Error("Scan at least two episodes first.");

  const digest = eps.map((e, i) =>
    `#${i + 1} "${e.title}"\n${e.segments.slice(0, 26).map((s) => s.t).join(" ").slice(0, 900)}`
  ).join("\n\n");

  const res = await openai().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content:
`These are excerpts from ${eps.length} episodes of one podcast.

Name the 6-10 subjects this show genuinely keeps returning to. Not one-off topics
— themes that appear across several episodes and that a listener would recognise
as what this show is about.

For each, give a short label (2-4 words) and a one-line description of the angle
this show takes on it.

Return ONLY JSON: {"themes":[{"label":"...","angle":"...","episodes":<how many mention it>}]}

${digest}` }],
    response_format: { type: "json_object" },
    temperature: 0.3,
  });

  const data = JSON.parse(res.choices[0].message.content);
  m.themes = (data.themes || []).slice(0, 10);
  persist();
  return m.themes;
}

// ---------- the payoff: best moments on a theme, across every episode ----------
async function mineTheme(userId, query) {
  const m = mine(userId);
  const eps = Object.values(m.episodes).filter((e) => e.segments);
  if (!eps.length) throw new Error("Nothing scanned yet.");

  // Narrow before spending tokens: only episodes whose words touch the query go
  // to the model. On a big catalogue this is the difference between one cheap
  // call and one that doesn't fit.
  const terms = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const scored = eps.map((e) => {
    const hay = e.segments.map((s) => s.t).join(" ").toLowerCase();
    return { e, hits: terms.reduce((a, t) => a + (hay.split(t).length - 1), 0) };
  }).filter((x) => x.hits > 0).sort((a, b) => b.hits - a.hits).slice(0, 12);

  if (!scored.length) return { query, moments: [], searched: eps.length };

  const corpus = scored.map(({ e }, i) => {
    const lines = e.segments.filter((s) =>
      terms.some((t) => s.t.toLowerCase().includes(t))
    ).slice(0, 40);
    // give the model a little context either side of each hit
    const idx = new Set();
    lines.forEach((l) => {
      const at = e.segments.indexOf(l);
      for (let k = Math.max(0, at - 2); k <= Math.min(e.segments.length - 1, at + 4); k++) idx.add(k);
    });
    const body = [...idx].sort((a, b) => a - b)
      .map((k) => `[${e.segments[k].s}-${e.segments[k].e}] ${e.segments[k].t}`).join("\n");
    return `EPISODE ${i}: "${e.title}"\n${body.slice(0, 4000)}`;
  }).join("\n\n");

  const res = await openai().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content:
`Below are excerpts from ${scored.length} episodes of one podcast, with timestamps.

Find the 6 strongest moments about: "${query}"

Each must be a complete thought that stands alone — 20 to 75 seconds, starting at
a sentence start and ending after the point lands. Never start on throat-clearing
("yeah", "so", "well", "I'm not an expert but") — the first line has to work as a
hook on its own. Pick from DIFFERENT episodes
where you can; the value here is showing the best answers across the whole show,
not six from one episode.

Use the timestamps exactly as given.

Return ONLY JSON:
{"moments":[{"episode":<index>,"start":<sec>,"end":<sec>,"title":"<max 8 words>","quote":"<the strongest sentence, verbatim>","why":"<one line: why this one>"}]}

${corpus}` }],
    response_format: { type: "json_object" },
    temperature: 0.4,
  });

  const picked = JSON.parse(res.choices[0].message.content).moments || [];

  // The model reliably picks the right spot and the wrong length — it latches
  // onto a single transcript line and hands back three seconds. Same failure the
  // clip pipeline had, same fix: keep its choice of where, decide the length
  // here by walking outward to sentence boundaries until the moment can stand
  // on its own.
  const MIN = 22, MAX = 75;
  function expand(ep, start, end) {
    const seg = ep.segments;
    let i = seg.findIndex((x) => x.e > start);
    let j = seg.findIndex((x) => x.s >= end);
    if (i < 0) i = 0;
    if (j < 0) j = seg.length - 1; else j = Math.max(i, j - 1);

    const ends = (n) => /[.!?]["')\]]?\s*$/.test((seg[n]?.t || "").trim());
    // A clip that opens "Yeah, so, I'm not an expert but…" is a wasted clip.
    // These are the openers that read as someone clearing their throat.
    const filler = (n) => /^\s*(yeah|yes|no|right|ok|okay|so|and|but|well|um|uh|i mean|you know|objectively|absolutely|exactly|sure|hmm|look|listen)\b/i
      .test((seg[n]?.t || "").trim())
      || /^\s*i'?m not (a|an) \w+ (expert|specialist)/i.test((seg[n]?.t || "").trim());

    // The model sometimes hands back a four-minute span. Expansion only ever
    // grows a pick, so without this those sailed through at 228 seconds — which
    // is not a short. Pull the end back to the last sentence that fits.
    if (seg[j] && seg[i] && seg[j].e - seg[i].s > MAX) {
      let k = i;
      while (k + 1 <= j && seg[k + 1].e - seg[i].s <= MAX) k++;
      let sentence = k;
      while (sentence > i && !ends(sentence)) sentence--;
      j = sentence > i ? sentence : k;
    }

    // grow backwards to the start of the sentence, then forwards until the
    // thought finishes and the clip is long enough to make sense alone
    while (i > 0 && !ends(i - 1)) i--;
    // If that landed on throat-clearing, step to the next real sentence — as
    // long as there is still enough clip left after it to be worth having.
    let guard = 0;
    while (filler(i) && i < j && guard++ < 4) {
      let n = i + 1;
      while (n < j && !ends(n - 1)) n++;
      if (n >= j || seg[j].e - seg[n].s < MIN) break;
      i = n;
    }
    while (seg[j] && (seg[j].e - seg[i].s < MIN || !ends(j)) && j < seg.length - 1
           && seg[j + 1].e - seg[i].s <= MAX) j++;
    while (i > 0 && seg[j].e - seg[i - 1].s <= MAX && seg[j].e - seg[i].s < MIN) i--;
    return { start: seg[i].s, end: Math.min(seg[j].e, seg[i].s + MAX) };
  }
  const moments = picked.map((p) => {
    const ep = scored[p.episode]?.e;
    if (!ep || typeof p.start !== "number" || p.end <= p.start) return null;
    const { start, end } = expand(ep, p.start, p.end);
    if (end - start < 10) return null;   // nothing coherent around it
    return {
      episodeTitle: ep.title, episodeUrl: ep.url, episodeDate: ep.date,
      start: +start.toFixed(1), end: +end.toFixed(1),
      seconds: Math.round(end - start),
      title: p.title, quote: p.quote, why: p.why,
      text: textFor(ep.segments.map((s) => ({ start: s.s, end: s.e, text: s.t })), p.start, p.end),
    };
  }).filter(Boolean);

  // Expansion can walk two picks onto the same stretch of tape.
  const unique = [];
  for (const m of moments.sort((a, b) => b.seconds - a.seconds)) {
    const clash = unique.some((u) => u.episodeUrl === m.episodeUrl
      && Math.min(u.end, m.end) - Math.max(u.start, m.start) > 0.4 * Math.min(u.seconds, m.seconds));
    if (!clash) unique.push(m);
  }
  return { query, moments: unique, searched: eps.length, episodesMatched: scored.length };
}

// ---------- routes ----------
export const catalogueRouter = Router();

catalogueRouter.get("/catalogue", (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please log in." });
  const m = lib[req.user.id];
  const feed = feedFor(req.user.id);
  res.json({
    enabled: planOf(req.user.plan).scheduler,
    feed: feed ? { show: feed.show, feedUrl: feed.feedUrl } : null,
    stats: catalogueStats(req.user.id),
    scan: m?.scan || null,
    themes: m?.themes || null,
    episodes: m ? Object.values(m.episodes).map((e) =>
      ({ title: e.title, date: e.date, minutes: Math.round((e.duration || 0) / 60), failed: e.failed || null })) : [],
  });
});

// What a scan would cost, before spending anything.
catalogueRouter.get("/catalogue/quote", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please log in." });
  const feed = feedFor(req.user.id);
  if (!feed) return res.status(400).json({ error: "Connect your podcast feed first." });
  try {
    const { episodes } = await fetchPodcastFeed(feed.feedUrl, 200);
    const m = lib[req.user.id];
    const todo = episodes.filter((e) => !m?.episodes[e.url]);
    const batch = todo.slice(0, MAX_PER_SCAN);
    const mins = batch.reduce((a, e) => a + (e.duration ? e.duration / 60 : 45), 0);
    res.json({
      show: feed.show,
      unscanned: todo.length,
      thisBatch: batch.length,
      estimatedMinutes: Math.round(mins),
      estimatedCost: +(mins * WHISPER_PER_MIN).toFixed(2),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

catalogueRouter.post("/catalogue/scan", (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please log in." });
  if (!planOf(req.user.plan).scheduler) {
    return res.status(403).json({ error: "Catalogue mining is a Creator/Pro feature.", upgrade: true });
  }
  const feed = feedFor(req.user.id);
  if (!feed) return res.status(400).json({ error: "Connect your podcast feed first." });
  const m = mine(req.user.id);
  if (m.scan?.status === "running") return res.json({ ok: true, already: true });

  const limit = Math.min(MAX_PER_SCAN, Math.max(1, parseInt(req.body?.limit, 10) || MAX_PER_SCAN));
  scanCatalogue(req.user.id, feed.feedUrl, limit).catch(() => {});
  res.json({ ok: true, started: true });
});

catalogueRouter.post("/catalogue/themes", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please log in." });
  try {
    res.json({ themes: await findThemes(req.user.id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

catalogueRouter.post("/catalogue/mine", async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please log in." });
  const query = String(req.body?.query || "").trim().slice(0, 120);
  if (!query) return res.status(400).json({ error: "What should I look for?" });
  try {
    res.json(await mineTheme(req.user.id, query));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
