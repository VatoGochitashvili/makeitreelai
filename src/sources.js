import { assertPublicUrl } from "./safe-url.js";

// Alternative, non-blockable video/audio sources.
//
// The point: every source here either hands us a file the user owns, or a
// public media URL that is *meant* to be downloaded. Unlike YouTube, none of
// them fight us — so these paths keep working.

// Turn a share link into a direct-download link where we can.
// Google Drive and Dropbox both serve a HTML preview page by default; these
// rewrites ask for the actual file instead. No OAuth needed for public links.
export function normalizeUrl(raw) {
  const url = String(raw || "").trim();

  // Google Drive: .../file/d/<id>/view  or  ...?id=<id>
  const gd = url.match(/drive\.google\.com\/(?:file\/d\/([\w-]+)|.*[?&]id=([\w-]+))/);
  if (gd) {
    const id = gd[1] || gd[2];
    return { url: `https://drive.google.com/uc?export=download&id=${id}`, kind: "drive" };
  }

  // Dropbox: ?dl=0 (preview page) -> ?dl=1 (direct file)
  if (/dropbox\.com/.test(url)) {
    const direct = url.replace(/[?&]dl=0/, "").replace(/[?&]raw=1/, "");
    const sep = direct.includes("?") ? "&" : "?";
    return { url: `${direct}${sep}dl=1`, kind: "dropbox" };
  }

  return { url, kind: "other" };
}

// A plain media file we can fetch directly (no extractor needed).
export function isDirectMedia(url) {
  return /\.(mp4|m4v|mov|webm|mkv|mp3|m4a|wav|aac|ogg)(\?|#|$)/i.test(url)
    || /drive\.google\.com\/uc\?export=download/.test(url)
    || /dropbox\.com.*dl=1/.test(url);
}

// ---------- podcast RSS ----------
// Podcast feeds list every episode with a direct <enclosure> media URL that is
// explicitly published for downloading — the most legitimate source there is.

function stripCdata(s = "") {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? stripCdata(m[1]) : "";
}
function decodeEntities(s = "") {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}
// "1:02:03" | "62:03" | "3723" -> seconds
function parseDuration(v) {
  if (!v) return null;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  const parts = v.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export async function fetchPodcastFeed(feedUrl, limit = 60) {
  // Feeds are user-supplied too, and autopilot re-fetches them on a timer.
  await assertPublicUrl(feedUrl);
  const res = await fetch(feedUrl, {
    headers: { "User-Agent": "MakeItReel/1.0 (podcast feed reader)" },
    signal: AbortSignal.timeout(15000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Feed returned ${res.status}`);

  const xml = await res.text();
  if (!/<rss|<feed|<channel/i.test(xml)) throw new Error("That doesn't look like a podcast feed.");

  const channel = xml.split(/<item[\s>]/i)[0];
  const show = decodeEntities(tag(channel, "title")) || "Podcast";
  const artwork =
    (channel.match(/<itunes:image[^>]*href=["']([^"']+)["']/i) || [])[1] ||
    (channel.match(/<url>([^<]+)<\/url>/i) || [])[1] || null;

  const episodes = [];
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const item of items) {
    const enc = item.match(/<enclosure[^>]*>/i);
    if (!enc) continue;
    const url = (enc[0].match(/url=["']([^"']+)["']/i) || [])[1];
    const type = (enc[0].match(/type=["']([^"']+)["']/i) || [])[1] || "";
    if (!url) continue;

    episodes.push({
      title: decodeEntities(tag(item, "title")) || "Episode",
      url: decodeEntities(url),
      date: tag(item, "pubDate") || null,
      duration: parseDuration(tag(item, "itunes:duration")),
      type,
    });
    if (episodes.length >= limit) break;
  }

  if (!episodes.length) throw new Error("No downloadable episodes found in that feed.");
  return { show, artwork, episodes };
}
