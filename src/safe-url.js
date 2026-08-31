// Refuse to fetch anything on a private network.
//
// The pipeline fetches whatever URL a user hands it. Unguarded, that turns the
// server into a proxy onto its own network: someone pastes
// http://169.254.169.254/latest/meta-data/ and the cloud metadata service —
// which on most hosts will hand out instance credentials — gets fetched,
// transcribed, and handed back as a "clip".
//
// Checked here at resolve time, on every path that takes a user-supplied URL:
// direct media, podcast feeds, and the previewer.

import { promises as dns } from "node:dns";
import net from "node:net";

const BLOCKED_V4 = [
  [10, 8], [127, 8], [169, 254, 16], [172, 16, 12], [192, 168, 16],
  [100, 64, 10],      // carrier-grade NAT
  [192, 0, 0, 24], [198, 18, 15], [224, 0, 4], [0, 8],
];

function v4Blocked(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const n = ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
  for (const rule of BLOCKED_V4) {
    const bits = rule[rule.length - 1];
    const base = [rule[0], rule[1] || 0, rule[2] || 0, 0];
    const b = ((base[0] << 24) >>> 0) + (base[1] << 16) + (base[2] << 8);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((n & mask) === (b & mask)) return true;
  }
  return false;
}

function v6Blocked(ip) {
  const a = ip.toLowerCase();
  return a === "::1" || a === "::" ||
         a.startsWith("fe80") ||           // link-local
         a.startsWith("fc") || a.startsWith("fd") ||   // unique local
         a.startsWith("::ffff:");          // v4-mapped, checked as v4 below
}

// Throws with a message safe to show a user; returns the parsed URL.
export async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("That doesn't look like a valid link."); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http and https links can be fetched.");
  }

  const host = u.hostname.replace(/^\[|\]$/g, "");
  // A literal address needs no lookup, and must not get one — the check has to
  // happen on the thing we will actually connect to.
  if (net.isIP(host)) {
    const bad = net.isIP(host) === 4
      ? v4Blocked(host)
      : (v6Blocked(host) || (host.toLowerCase().startsWith("::ffff:") && v4Blocked(host.split(":").pop())));
    if (bad) throw new Error("That address is on a private network, so we can't fetch it.");
    return u;
  }

  let records;
  try { records = await dns.lookup(host, { all: true }); }
  catch { throw new Error("We couldn't find that host."); }
  if (!records.length) throw new Error("We couldn't find that host.");

  for (const { address, family } of records) {
    const bad = family === 4
      ? v4Blocked(address)
      : (v6Blocked(address) || (address.toLowerCase().startsWith("::ffff:") && v4Blocked(address.split(":").pop())));
    // Every answer must be public: one private record is enough to abuse.
    if (bad) throw new Error("That host resolves to a private network address, so we can't fetch it.");
  }
  return u;
}
