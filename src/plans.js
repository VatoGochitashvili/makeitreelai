// Plan capabilities — the single source of truth for what each tier can do.
// videosPerMonth: -1 means unlimited (kept as a number so it JSON-serializes).

export const PLANS = {
  free: {
    key: "free", name: "Free", price: 0, blurb: "Kick the tires.",
    clipsPerVideo: 3, videosPerMonth: 2, resolution: 720,
    captions: true, voiceover: false, scheduler: false, faceTracking: false, workspaces: 1,
  },
  creator: {
    key: "creator", name: "Creator", price: 19, blurb: "For serious podcasters.",
    clipsPerVideo: 10, videosPerMonth: -1, resolution: 1080,
    captions: true, voiceover: true, scheduler: true, faceTracking: false, workspaces: 1,
  },
  pro: {
    key: "pro", name: "Pro", price: 49, blurb: "Agencies & teams.",
    clipsPerVideo: 10, videosPerMonth: -1, resolution: 1080,
    captions: true, voiceover: true, scheduler: true, faceTracking: true, workspaces: 3,
  },
};

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
