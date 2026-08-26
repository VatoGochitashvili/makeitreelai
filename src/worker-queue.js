// "Bring your own IP" download worker.
//
// YouTube blocks datacenter IPs (the server), but not home connections. So
// instead of renting a residential proxy, a small script on the user's own
// machine can do the downloading and hand the file back.
//
// The machine only makes OUTBOUND https calls to us, so there's no tunnel, no
// port forwarding and nothing exposed to the internet.

import { Router } from "express";
import { randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";

const WAIT_MS = 15 * 60 * 1000; // give the worker 15 minutes to deliver

const pending = new Map(); // id -> { id, url, status, file, resolve, reject, at }

export function workerEnabled() {
  return !!process.env.WORKER_TOKEN;
}

// Queue a download and wait until a worker delivers the file (or we time out).
export function requestDownload(url, dir, log) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const job = { id, url, dir, status: "pending", file: null, resolve, reject, at: Date.now() };
    pending.set(id, job);
    log("Waiting for your download helper to fetch this video…");

    job.timer = setTimeout(() => {
      if (pending.get(id)?.status !== "done") {
        pending.delete(id);
        reject(new Error(
          "No download helper responded. Start it on your computer (npm run worker), " +
          "or upload the file directly."
        ));
      }
    }, WAIT_MS);
    job.timer.unref?.();
  });
}

export const workerRouter = Router();

function checkToken(req, res) {
  const token = req.get("x-worker-token") || req.query.token;
  if (!process.env.WORKER_TOKEN || token !== process.env.WORKER_TOKEN) {
    res.status(401).json({ error: "Bad or missing worker token." });
    return false;
  }
  return true;
}

// If a helper claims a job and then dies or restarts, the job must not be
// stranded — put it back after a grace period so another poll picks it up.
const CLAIM_GRACE_MS = 90 * 1000;

// The helper polls this for something to download.
workerRouter.get("/worker/next", (req, res) => {
  if (!checkToken(req, res)) return;
  const now = Date.now();
  for (const job of pending.values()) {
    const stale = job.status === "claimed" && now - job.claimedAt > CLAIM_GRACE_MS;
    if (job.status === "pending" || stale) {
      job.status = "claimed";
      job.claimedAt = now;
      return res.json({ id: job.id, url: job.url });
    }
  }
  res.json({ id: null }); // nothing to do
});

// The helper streams the downloaded file back here.
workerRouter.post("/worker/deliver/:id", (req, res) => {
  if (!checkToken(req, res)) return;
  const job = pending.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Unknown or expired download." });

  const file = path.join(job.dir, "source.mp4");
  const out = createWriteStream(file);
  let bytes = 0;
  req.on("data", (c) => (bytes += c.length));
  req.pipe(out);

  out.on("error", () => {
    res.status(500).json({ error: "Could not save the file." });
  });
  out.on("finish", () => {
    if (!bytes) return res.status(400).json({ error: "Empty upload." });
    clearTimeout(job.timer);
    job.status = "done";
    job.file = file;
    pending.delete(job.id);
    job.resolve(file);
    res.json({ ok: true, bytes });
  });
});

// The helper reports a failure so the job fails fast instead of timing out.
workerRouter.post("/worker/fail/:id", (req, res) => {
  if (!checkToken(req, res)) return;
  const job = pending.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Unknown download." });
  clearTimeout(job.timer);
  pending.delete(job.id);
  job.reject(new Error((req.body && req.body.error) || "The download helper couldn't fetch that video."));
  res.json({ ok: true });
});

// Simple status for the UI: is a helper connected right now?
let lastSeen = 0;
workerRouter.get("/worker/ping", (req, res) => {
  if (!checkToken(req, res)) return;
  lastSeen = Date.now();
  res.json({ ok: true });
});
export function workerOnline() {
  return Date.now() - lastSeen < 60 * 1000;
}
