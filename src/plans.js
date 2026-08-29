// Plan capabilities — the single source of truth for what each tier can do.
// videosPerMonth: -1 means unlimited (kept as a number so it JSON-serializes).

// What a plan costs us, so a limit can be argued about rather than guessed.
// Whisper is $0.006/min and dominates; GPT selection is under a cent a run.
// At 20 hours a Creator plan spends ~$7.20 of transcription against $19 —
// roughly a third, which leaves room for storage, egress and the occasional
// heavy month. "Unlimited" was not a plan, it was an open tab: one customer
// running a hundred 2-hour shows cost $73 and paid $19.
export const MINUTE_COST = 0.006;

export const PLANS = {
  free: {
    key: "free", name: "Free", price: 0, blurb: "Kick the tires.",
    clipsPerVideo: 3, videosPerMonth: 2, minutesPerMonth: 60, maxSourceMinutes: 90,
    resolution: 720,
    captions: true, voiceover: false, scheduler: false, faceTracking: false, workspaces: 1,
    maxUploadMB: 500,
  },
  creator: {
    key: "creator", name: "Creator", price: 19, blurb: "For serious podcasters.",
    clipsPerVideo: 10, videosPerMonth: -1, minutesPerMonth: 1200, maxSourceMinutes: 240,
    resolution: 1080,
    captions: true, voiceover: true, scheduler: true, faceTracking: false, workspaces: 1,
    maxUploadMB: 2048,
  },
  pro: {
    key: "pro", name: "Pro", price: 49, blurb: "Agencies & teams.",
    clipsPerVideo: 10, videosPerMonth: -1, minutesPerMonth: 3000, maxSourceMinutes: 360,
    resolution: 1080,
    captions: true, voiceover: true, scheduler: true, faceTracking: true, workspaces: 3,
    maxUploadMB: 5120,
  },
};

export const fmtHours = (min) =>
  min % 60 === 0 ? `${min / 60} hours` : `${(min / 60).toFixed(1)} hours`;

// AI voiceover narration voices (OpenAI TTS voice ids).
export const VOICES = [
  { id: "alloy", label: "Alloy — neutral" },
  { id: "nova", label: "Nova — warm" },
  { id: "onyx", label: "Onyx — deep" },
  { id: "shimmer", label: "Shimmer — bright" },
  { id: "echo", label: "Echo — calm" },
  { id: "fable", label: "Fable — storyteller" },
];
export const VOICE_IDS = new Set(VOICES.map((v) => v.id));

export function planOf(key) {
  return PLANS[key] || PLANS.free;
}
