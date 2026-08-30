// Plan capabilities — the single source of truth for what each tier can do.
// videosPerMonth: -1 means unlimited (kept as a number so it JSON-serializes).

// Allowances come from src/credits.js, so a plan can never promise more than
// the margin allows. 1 credit = 1 minute of source video; narrated formats cost
// extra per clip because they make extra model calls.
//
// These were 1200 and 3000, set against Whisper alone. Counting compute, egress,
// storage and the narration extras, that was a 39% margin — the plans were
// roughly twice as generous as the business could carry.
export const TRIAL_DAYS = 7;

export const PLANS = {
  // Everyone starts here: the Creator product for a week, with enough credits
  // to judge it properly (two hours of video) rather than a crippled version of
  // it. A trial that hides the good parts only proves the bad ones.
  trial: {
    key: "trial", name: "Creator trial", price: 0, blurb: `${TRIAL_DAYS} days of the full thing.`,
    clipsPerVideo: 10, credits: 120, maxSourceMinutes: 120,
    resolution: 1080,
    captions: true, voiceover: true, scheduler: true, faceTracking: false, workspaces: 1,
    maxUploadMB: 2048,
    trial: true,
  },
  // Not a plan anyone chooses — where an account lands when the trial ends or a
  // subscription lapses. The library stays readable; nothing new can be made.
  free: {
    key: "free", name: "Expired", price: 0, blurb: "Your trial has ended.",
    clipsPerVideo: 0, credits: 0, maxSourceMinutes: 0,
    resolution: 720,
    captions: true, voiceover: false, scheduler: false, faceTracking: false, workspaces: 1,
    maxUploadMB: 500,
    lapsed: true,
  },
  creator: {
    key: "creator", name: "Creator", price: 19, blurb: "For serious podcasters.",
    clipsPerVideo: 10, credits: 600, maxSourceMinutes: 180,
    resolution: 1080,
    captions: true, voiceover: true, scheduler: true, faceTracking: false, workspaces: 1,
    maxUploadMB: 2048,
  },
  pro: {
    key: "pro", name: "Pro", price: 49, blurb: "Agencies & teams.",
    clipsPerVideo: 10, credits: 1500, maxSourceMinutes: 300,
    resolution: 1080,
    captions: true, voiceover: true, scheduler: true, faceTracking: true, workspaces: 3,
    maxUploadMB: 5120,
  },
};

// Top-ups. Priced at the same margin as the plans, and they do not expire —
// someone who paid for capacity keeps it, which is the difference between a
// top-up and a penalty.
export const CREDIT_PACKS = [
  { id: "small",  credits: 250,  price: 9,  label: "250 credits" },
  { id: "medium", credits: 750,  price: 25, label: "750 credits" },
  { id: "large",  credits: 2000, price: 59, label: "2,000 credits" },
];

export const fmtHours = (min) =>
  min % 60 === 0 ? `${min / 60} hours` : `${(min / 60).toFixed(1)} hours`;
export const fmtCredits = (c) => `${Math.round(c).toLocaleString()} credits`;

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
