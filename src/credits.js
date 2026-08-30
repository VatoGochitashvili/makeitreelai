// What a run actually costs, and what a plan can therefore afford.
//
// The previous limit counted Whisper and nothing else, which made the plans
// look about twice as generous as they are. Everything measurable is in here so
// the pricing, the enforcement and the number shown to the customer all come
// from one place — if they disagree, one of them is a lie.
//
// A CREDIT is one minute of source video processed. It is the unit customers
// see because it is the one they can predict: a 40-minute episode costs 40
// credits, before extras.

// ---- direct, per unit, from the providers' published rates ----
export const RATE = {
  whisperPerMin: 0.006,        // transcription of the source
  gptPerMinOfSource: 0.00004,  // moment selection: ~12k tokens for a 60-min show
  ttsPerClip: 0.004,           // ~250 characters of narration
  whisperBackPerClip: 0.002,   // re-transcribing our own TTS for caption timing
  gptRewritePerClip: 0.0003,   // rewriting a moment as a spoken script
};

// ---- infrastructure, allocated per minute of source ----
// A 60-minute source produces ~10 clips at ~20MB. Stored for 30 days and served
// a couple of times, that is roughly 7MB of egress and 3MB-months of storage
// per source minute, plus the CPU to encode it. Estimated, not billed to us per
// unit — hence one number rather than false precision.
export const INFRA_PER_MIN = 0.0025;

// Stripe takes its cut before you see any of it, and on a $19 subscription the
// flat 30c is a bigger deal than the percentage. Omitting this made every
// margin here look ~4 points better than it is.
export const STRIPE_PCT = 0.029;
export const STRIPE_FLAT = 0.30;
export const paymentFee = (price) => price > 0 ? price * STRIPE_PCT + STRIPE_FLAT : 0;

// The margin the business is run at. Change this and every plan's allowance
// moves with it; that is the point of having it here.
export const TARGET_MARGIN = 0.70;

// Worst case: every clip narrated, which is the most expensive thing we offer.
export function costPerCredit(clipsPerCredit = 10 / 60) {
  return RATE.whisperPerMin + RATE.gptPerMinOfSource + INFRA_PER_MIN
       + clipsPerCredit * (RATE.ttsPerClip + RATE.whisperBackPerClip + RATE.gptRewritePerClip);
}

// What a run costs in credits. Source length is the base; the formats that make
// extra model calls per clip cost more, because they do.
export function creditsFor({ minutes, clips = 0, voiceover = false, format = "clip" }) {
  let c = Math.max(0.1, minutes);
  if (format === "brainrot") c += clips * 0.9;   // rewrite + TTS + Whisper back
  else if (voiceover) c += clips * 0.4;          // TTS + a short Whisper pass
  return Math.round(c * 10) / 10;
}

// How many credits a price can carry at the target margin.
export function creditsForPrice(price, margin = TARGET_MARGIN) {
  if (price <= 0) return 0;
  return Math.floor((price * (1 - margin)) / costPerCredit() / 25) * 25;
}

// A plain-language breakdown, used by the pricing page and by anyone asking
// where the numbers came from.
export function economics(price, credits) {
  const cost = credits * costPerCredit();
  return {
    price, credits,
    hours: +(credits / 60).toFixed(1),
    worstCaseCost: +cost.toFixed(2),
    marginPct: price > 0 ? Math.round((1 - cost / price) * 100) : null,
    costPerCredit: +costPerCredit().toFixed(5),
  };
}

// What one subscriber is actually worth, which is not the worst case: almost
// nobody spends every credit. `used` is the fraction of the allowance they get
// through in a month.
export function userMargin(price, credits, used = 1, fixedPerUser = 0) {
  const ai = credits * used * costPerCredit();
  const fee = paymentFee(price);
  const cost = ai + fee + fixedPerUser;
  return {
    used, revenue: price,
    aiCost: +ai.toFixed(2), paymentFee: +fee.toFixed(2), fixed: +fixedPerUser.toFixed(2),
    totalCost: +cost.toFixed(2),
    profit: +(price - cost).toFixed(2),
    marginPct: Math.round((1 - cost / price) * 100),
  };
}
