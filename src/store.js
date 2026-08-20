// Tiny file-backed persistence — no DB dependency for the MVP.
// Each collection is a JSON file under .data/. Reads are sync (module load);
// writes are debounced so hot paths don't hammer the disk.
// (Swap for a real database later — see roadmap.)

import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Where persisted JSON lives. Set DATA_DIR to a mounted disk (e.g. /var/data
// on Render) so accounts, schedule and reels survive restarts and redeploys.
export const DATA_DIR = process.env.DATA_DIR
  || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".data");

export function readJSON(name, fallback) {
  try {
    return JSON.parse(readFileSync(path.join(DATA_DIR, name), "utf8"));
  } catch {
    return fallback;
  }
}

const timers = {};
export function writeJSON(name, getData) {
  clearTimeout(timers[name]);
  timers[name] = setTimeout(async () => {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(path.join(DATA_DIR, name), JSON.stringify(getData(), null, 2));
    } catch (_) { /* best effort */ }
  }, 250);
  timers[name].unref?.();
}
