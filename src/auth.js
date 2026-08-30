// Lightweight, dependency-free accounts for MakeItReel.
// In-memory users (swap for a DB later — see roadmap), passwords hashed with
// scrypt, sessions carried in an HMAC-signed HttpOnly cookie.
// NOTE: no billing here — `plan` is just the user's selected tier. Payments come later.

import { Router } from "express";
import {
  randomBytes, randomUUID, scryptSync, timingSafeEqual, createHmac,
} from "node:crypto";
import { PLANS, planOf } from "./plans.js";
import { readJSON, writeJSON, DATA_DIR } from "./store.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const users = new Map(); // email(lowercased) -> { id, name, email, plan, salt, hash, createdAt, usage, connections }
// Restore persisted accounts.
for (const u of readJSON("users.json", [])) users.set(u.email, u);
// Debounced save of all accounts.
function persist() { writeJSON("users.json", () => Array.from(users.values())); }

const SOCIAL_PLATFORMS = new Set(["tiktok", "instagram", "youtube"]);
const SOCIAL_HANDLES = { tiktok: "@yourbrand", instagram: "@yourbrand", youtube: "Your Channel" };
const VALID_PLANS = new Set(["free", "creator", "pro"]);
const COOKIE = "mir_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// Signs session cookies. Generating a fresh one each boot silently logged
// everyone out on every restart, so persist it alongside the other data.
// SESSION_SECRET (env) still wins when set — that's what production should use.
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, "session-secret");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch { /* first run */ }
  const fresh = randomBytes(32).toString("hex");
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file, fresh, { mode: 0o600 });
  } catch { /* not writable — sessions just won't survive a restart */ }
  return fresh;
}
const SECRET = loadSecret();

// ---------- password hashing ----------
function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(password, salt, expectedHash) {
  const hash = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, "hex");
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

// ---------- signed session cookie ----------
function sign(userId) {
  const mac = createHmac("sha256", SECRET).update(userId).digest("hex");
  return `${userId}.${mac}`;
}
function unsign(token) {
  if (!token || !token.includes(".")) return null;
  const idx = token.lastIndexOf(".");
  const userId = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expected = createHmac("sha256", SECRET).update(userId).digest("hex");
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return userId;
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setSession(res, userId) {
  const token = sign(userId);
  res.setHeader("Set-Cookie",
    `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${MAX_AGE}; SameSite=Lax`);
}
function clearSession(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

// Look up the signed-in user for a request (or null).
function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  const userId = token && unsign(token);
  if (!userId) return null;
  for (const u of users.values()) if (u.id === userId) return u;
  return null;
}
function publicUser(u) {
  return u ? { id: u.id, name: u.name, email: u.email, plan: u.plan } : null;
}

// ---------- monthly usage tracking ----------
// Look a user up by id — the autopilot works from stored feeds, not sessions,
// so it has an id and no cookie to resolve it with.
export function findUserById(id) {
  for (const u of users.values()) if (u.id === id) return u;
  return null;
}

export function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
// Returns the user's usage record for the current month, resetting on rollover.
export function getUsage(user) {
  const m = monthKey();
  if (!user.usage || user.usage.month !== m) user.usage = { month: m, videos: 0, credits: 0 };
  if (user.usage.credits == null) user.usage.credits = user.usage.minutes || 0;  // pre-credits accounts
  if (user.topUpCredits == null) user.topUpCredits = 0;
  return user.usage;
}

// The monthly allowance resets; bought credits do not. Someone who paid for
// capacity keeps it — that is what separates a top-up from a penalty.
export function creditBalance(user) {
  const u = getUsage(user);
  const plan = planOf(user.plan);
  // Rounded down for display so nobody is shown 598.5788889, and so the number
  // never promises a credit that isn't there.
  const allowance = Math.max(0, Math.floor(plan.credits - u.credits));
  const topUp = Math.floor(user.topUpCredits || 0);
  return {
    allowance, topUp, total: allowance + topUp,
    used: Math.ceil(u.credits), planCredits: plan.credits,
    onHold: allowance + topUp <= 0,
  };
}

// Spend the monthly allowance first, then anything bought — so purchased
// credits survive to the next month rather than being burned in front of a
// resource that was about to reset anyway.
export function spendCredits(user, credits) {
  const u = getUsage(user);
  const plan = planOf(user.plan);
  const fromAllowance = Math.min(credits, Math.max(0, plan.credits - u.credits));
  u.credits += fromAllowance;
  const rest = credits - fromAllowance;
  if (rest > 0) user.topUpCredits = Math.max(0, (user.topUpCredits || 0) - rest);
  persist();
  return creditBalance(user);
}

export function refundCredits(user, credits) {
  const u = getUsage(user);
  u.credits = Math.max(0, u.credits - credits);
  persist();
  return creditBalance(user);
}

export function addTopUp(user, credits) {
  user.topUpCredits = (user.topUpCredits || 0) + credits;
  persist();
  return creditBalance(user);
}
// Cancelling a run gives the monthly allowance back.
export function refundVideoUsage(user) {
  const u = getUsage(user);
  u.videos = Math.max(0, u.videos - 1);
  persist();
  return u;
}

export function bumpVideoUsage(user) {
  const u = getUsage(user);
  u.videos += 1;
  persist();
  return u;
}

// Source minutes are what actually cost money, so they are what we meter.
// Charged from the known duration where we have one, and reconciled against the
// real figure once the transcript tells us the truth.
// The site promises an ownership check before launch. Recorded once per
// account rather than nagged on every run — it is a commitment, not a warning
// label, and repeating it just trains people to click past it.
export function ackOwnership(user) {
  user.ownershipAckAt = Date.now();
  persist();
  return user;
}

// Only the Stripe webhook calls this — the plan follows the subscription, never
// a request from the browser.
export function setPlan(user, plan, stripeCustomerId) {
  if (PLANS[plan]) user.plan = plan;
  if (stripeCustomerId) user.stripeCustomerId = stripeCustomerId;
  persist();
  return user;
}

export function chargeMinutes(user, minutes) {
  const u = getUsage(user);
  u.minutes = Math.max(0, u.minutes + (Number(minutes) || 0));
  persist();
  return u;
}

// Express middleware: attaches req.user (or null).
export function attachUser(req, _res, next) {
  req.user = currentUser(req);
  next();
}

// ---------- routes ----------
export const authRouter = Router();

authRouter.post("/register", (req, res) => {
  let { name, email, password, plan } = req.body || {};
  name = (name || "").trim();
  email = (email || "").trim().toLowerCase();
  plan = VALID_PLANS.has(plan) ? plan : "free";

  if (!name) return res.status(400).json({ error: "Please enter your name." });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Please enter a valid email." });
  if (!password || password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  if (users.has(email)) return res.status(409).json({ error: "An account with that email already exists." });

  const { salt, hash } = hashPassword(password);
  const user = { id: randomUUID(), name, email, plan, salt, hash, createdAt: Date.now() };
  users.set(email, user);
  persist();
  setSession(res, user.id);
  res.status(201).json({ user: publicUser(user) });
});

authRouter.post("/login", (req, res) => {
  let { email, password } = req.body || {};
  email = (email || "").trim().toLowerCase();
  const user = users.get(email);
  // Same message either way, so we don't reveal which emails exist.
  if (!user || !verifyPassword(password || "", user.salt, user.hash)) {
    return res.status(401).json({ error: "Wrong email or password." });
  }
  setSession(res, user.id);
  res.json({ user: publicUser(user) });
});

authRouter.post("/logout", (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

authRouter.get("/me", (req, res) => {
  const user = currentUser(req);
  if (!user) return res.json({ user: null });
  const plan = planOf(user.plan);
  const usage = getUsage(user);
  res.json({
    user: publicUser(user),
    plan,
    usage: { videos: usage.videos, ...creditBalance(user) },
    connections: user.connections || {},
    ownershipAck: !!user.ownershipAckAt,
  });
});

// Link / unlink a social account for the auto-post scheduler.
// DEV STUB: real publishing needs each platform's OAuth + posting API
// (TikTok Content Posting API, Instagram Graph API, YouTube Data API). This
// records a connection so the scheduler flow works end-to-end until then.
authRouter.post("/connect/:platform", (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Please log in first." });
  const p = req.params.platform;
  if (!SOCIAL_PLATFORMS.has(p)) return res.status(400).json({ error: "Unknown platform." });
  user.connections = user.connections || {};
  user.connections[p] = { handle: SOCIAL_HANDLES[p], at: Date.now() };
  persist();
  res.json({ connections: user.connections });
});

authRouter.delete("/connect/:platform", (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Please log in first." });
  const p = req.params.platform;
  if (user.connections) delete user.connections[p];
  persist();
  res.json({ connections: user.connections || {} });
});

// Update profile (name).
authRouter.post("/account", (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Please log in first." });
  const name = ((req.body || {}).name || "").trim();
  if (!name) return res.status(400).json({ error: "Name can't be empty." });
  user.name = name;
  persist();
  res.json({ user: publicUser(user) });
});

// Change password.
authRouter.post("/ownership", (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Please log in." });
  if (req.body?.confirm !== true) return res.status(400).json({ error: "Confirmation required." });
  ackOwnership(user);
  res.json({ ok: true });
});

authRouter.post("/password", (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Please log in first." });
  const { current, next } = req.body || {};
  if (!verifyPassword(current || "", user.salt, user.hash)) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }
  if (!next || next.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters." });
  }
  const { salt, hash } = hashPassword(next);
  user.salt = salt; user.hash = hash;
  persist();
  res.json({ ok: true });
});

// Delete own account (user-initiated).
authRouter.delete("/account", (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Please log in first." });
  users.delete(user.email);
  persist();
  clearSession(res);
  res.json({ ok: true });
});

// ---------- social sign-in ----------
// DEV STUB: real "Continue with Google/Apple" needs provider credentials
// (Google OAuth client ID, Apple Service ID + key) and a public callback URL.
// Until those are set, this signs the visitor into a per-provider demo account
// so the whole signup/redirect flow is testable end-to-end.
const OAUTH_DEMO = {
  google: { email: "google.demo@gmail.com", name: "Google User" },
  apple: { email: "apple.demo@icloud.com", name: "Apple User" },
};
authRouter.post("/oauth/:provider", (req, res) => {
  const provider = req.params.provider;
  const demo = OAUTH_DEMO[provider];
  if (!demo) return res.status(400).json({ error: "Unknown provider." });

  let user = users.get(demo.email);
  if (!user) {
    // No usable password for social accounts — random, unusable hash.
    const { salt, hash } = hashPassword(randomBytes(24).toString("hex"));
    user = { id: randomUUID(), name: demo.name, email: demo.email, plan: "free", provider, salt, hash, createdAt: Date.now() };
    users.set(demo.email, user);
    persist();
  }
  setSession(res, user.id);
  res.json({ user: publicUser(user), provider });
});

// ---------- seeded test accounts ----------
// Handy logins for trying each plan's logged-in interface. In-memory only;
// re-seeded on every boot so they always exist. Remove before production.
function seedTestUsers() {
  const seeds = [
    { name: "Free Tester", email: "free@test.com", plan: "free" },
    { name: "Creator Tester", email: "creator@test.com", plan: "creator" },
    { name: "Pro Tester", email: "pro@test.com", plan: "pro" },
  ];
  let added = false;
  for (const s of seeds) {
    if (users.has(s.email)) continue;
    const { salt, hash } = hashPassword("test1234");
    users.set(s.email, { id: randomUUID(), ...s, salt, hash, createdAt: Date.now() });
    added = true;
  }
  if (added) persist();
}
seedTestUsers();

// Change the selected plan (no billing — just records the choice).
// Switching plans without paying. This existed so the tiers could be tried
// before billing was built — with Stripe configured it would be a free upgrade
// for anyone who could open devtools, so it only survives while billing is off,
// and it can never be used to reach a paid tier once it is on.
authRouter.post("/plan", (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "Please log in first." });
  const plan = (req.body || {}).plan;
  if (!VALID_PLANS.has(plan)) return res.status(400).json({ error: "Unknown plan." });

  const billingLive = !!process.env.STRIPE_SECRET_KEY;
  if (billingLive && PLANS[plan]?.price > 0) {
    return res.status(402).json({ error: "Paid plans go through checkout.", checkout: true });
  }
  user.plan = plan;
  persist();
  res.json({ user: publicUser(user) });
});
