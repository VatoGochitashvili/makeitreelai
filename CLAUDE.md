# MakeItReel — project context for Claude Code

## What this is
An AI tool that turns one long video (YouTube/podcast) into several ready-to-post vertical clips.
Competitor to Opus Clip. Target customer at launch: **podcasters** (then coaches, then faceless channels).
Business model: monthly subscription (~$19/mo). Planned differentiator vs Opus: an **auto-post scheduler**.

## Stack
- Node.js (ES modules) + Express
- OpenAI API — Whisper (transcription) + GPT (moment selection)
- `yt-dlp` (download) and `ffmpeg` (cut + vertical reframe + captions) — external CLI tools
- Vanilla HTML/CSS/JS frontend in `public/`

## Layout
- `server.js` — Express server; routes `POST /api/clip` (start job) and `GET /api/jobs/:id` (poll status/logs/clips). In-memory job store.
- `src/pipeline.js` — the pipeline: `makeClips(url, log)` → download → transcribe → selectMoments (GPT) → cutClip (ffmpeg). Returns clip files + metadata.
- `public/index.html`, `public/podcast.html`, `public/upload.html` — three
  single-purpose home pages (YouTube link / RSS feed / file upload). Same
  markup; `<body data-source>` picks which input shows.
- `public/studio.html` — the signed-in workspace: all three sources behind
  tabs, plus the plan strip and autopilot (`data-plan-meta="on"`).
- `public/tool.js` — the tool, shared by all four. Was duplicated inline in
  every page; don't copy it back.
- `src/backgrounds.js` — gameplay footage library for the split/brainrot formats.
- `.env` — needs `OPENAI_API_KEY` (copy from `.env.example`).

## How to run
```bash
cp .env.example .env      # add your OPENAI_API_KEY
npm install
npm start                 # http://localhost:3000
```
Requires `ffmpeg` and `yt-dlp` on PATH (macOS: `brew install ffmpeg yt-dlp`).

## Framing (why clips looked over-zoomed)
A full-bleed 9:16 crop of a 16:9 source keeps only ~32% of the width and
magnifies 1.78x. That's geometry, not a setting — the only way to zoom out is
to stop filling the frame edge to edge. Hence three `layout` options:
- `balanced` (default) — keeps ~48% of the width centred on the speaker, sized
  to fill ~66% of the frame height, blurred fill above and below. ~1.17x.
- `crop` — the old full-bleed behaviour. Tightest.
- `fit` — the whole frame, letterboxed. Smallest subject.

`trackSubject` measures where the subject is over time and hands `cutClip` a
handful of keyframes, which become a piecewise-linear crop-x expression so the
window follows them. A speaker crossing the frame spreads their motion over it,
which is the case `findSubjectX` gives up on — so the tracker runs first and the
single-point measurement is the fallback, not the gate. Commas in that
expression must be escaped: the filter string is comma-separated, and an
unescaped `if()` silently becomes three broken filters.

## Output formats
`format` in the generate request picks how a clip is rendered:
- `clip` — the speaker, cropped to 9:16 (default)
- `split` — the clip on top, gameplay underneath, original audio
- `brainrot` — gameplay fills the frame, an AI voice reads a GPT-rewritten
  script, and the source video never appears

The last two need background footage, which we can't ship (it's someone's
copyright). Drop files in `assets/backgrounds/` for a shared library, or let
users upload their own from the Studio — see `src/backgrounds.js`.

Captioning narration works by sending the TTS audio back through Whisper: we
know the words but not their timing, and a clean synthetic voice transcribes
almost exactly.

## Autopilot (the differentiator)
Opus hands you clips and stops. `src/autopilot.js` closes the loop: a creator
connects their podcast RSS once, and every new episode is clipped and queued to
post with nobody at the keyboard.

- polls each active feed every 30 min; newest unseen episode only, one per pass
- the first sync marks the back catalogue as seen, so connecting a feed doesn't
  spend a month's quota
- finished clips are spaced one per day at the user's chosen hour
- `startJob()` in `server.js` is the shared entry point — the route validates
  and replies, autopilot calls it directly with no req/res

Still simulated: actual publishing. `src/scheduler.js` flips due posts to
"posted" without calling TikTok/Instagram/YouTube. Those APIs need registered
apps, OAuth, and (for TikTok) an audit — start the applications early.

## Features pages
`public/features.html` is the index; `public/f/<slug>.html` is a page each — seven
of them, one per working feature.

The demo source in `public/demo-assets/` is ours end to end — our script, our
TTS, and two scenes rendered from `assets/demo-scenes/` (a podcast studio and a
blocky parkour course) — precisely so the outputs can be published without using
anyone else's footage. The first version drew the scene with ffmpeg boxes and it
looked it; the scenes are HTML rendered through headless Chrome instead, which
is why the clips now read as real short-form content. Everything on a Live feature's page came
out of a real pipeline run against it (`run.json` holds the actual moment picks
and model calls).

Soon features get a "Not built yet" panel and a schematic labelled as one. Do
not put a mocked-up artifact on a Soon page: the badge and the panel are the
only things standing between the marketing and a refund request.

To regenerate the assets, run the pipeline against `demo-assets/source.mp4`
with `layout: balanced` and `layout: crop` (the Smart Frame pair), plus
`format: split` and `format: brainrot`.

## Features page (menu + grid)
`public/features.html` lists all sixteen, each with a CSS-only animated demo of
the mechanism (`public/demos.css`). No JS, so a demo can't fail to start, and
they all stop under `prefers-reduced-motion`. The nav's Features menu links
here by anchor.

If you add a feature, it needs three things in step: an entry in the menu and
the on-page grid, a row on features.html, and a demo in demos.css.

## Feature demos
Each demo is a mechanism diagram (`public/demos.css`): what goes in, what the
feature does to it, what comes out — in an app window, full width. The test is
whether someone can say what the feature does without reading the paragraph
beside it. Abstract shapes failed that test; so did a static UI panel.

All seventeen share one small system, declared as tokens at the top of
`demos.css`: three radii, three elevations, one accent used sparingly. That is
what stops them reading as seventeen separate drawings — change a token, not a
component, when something needs adjusting.

The figures in a diagram must match the run beside it. Smart Frame draws its
crop windows at 32% and 48% of the real source frame because those are the
numbers the page quotes and the clips demonstrate; drawing them "about right"
would make the page quietly wrong.

Where the pipeline has real output, the demo plays that clip. Where it doesn't,
the mockup is still built from real material (the actual API shape, the real
activity log) and the page says "Not built yet".

## Feature naming
The nav's Features menu and the on-page grid share one generated list. Seven
features, all Live — nothing on that page is a promise. Everything unbuilt is a
line in `ROADMAP`, rendered as plain text at the foot of features.html and
explicitly labelled as not built.

Ten "Soon" entries used to sit alongside the real ones. They read as an
unfinished product and invited a feature-count comparison we lose. Do not add a
feature to the list before it works; add it to the roadmap.

Names are deliberately ours, not Opus Clip's: Moment Finder (not ClipAnything),
Kinetic Captions, Smart Frame (not AI Reframe), Autopilot (not Social
scheduler), Catalogue Miner, Gameplay Shorts, Voice Over.


## Back catalogue miner (`src/catalogue.js`)
The thing no one-file-at-a-time tool can do. It transcribes a show's whole
history once, names the themes it keeps returning to, then finds the strongest
moments on a theme *across every episode* — "you've talked about burnout in
fourteen episodes, here are the six best answers".

- transcripts only, audio-only download: a 45-min episode is ~$0.27 and a few MB
- `/api/catalogue/quote` prices a scan before it runs; the UI shows the figure
  and asks. Never start a scan without that — a 100-episode catalogue is real money
- capped at 40 episodes per scan
- mining narrows by keyword first so only matching episodes reach the model
- a scan is an in-process loop, so a restart marks it interrupted and keeps what
  it already read

Why it matters commercially: it delivers value on day one from work the customer
already did, and it compounds — a competitor can't ship it as a feature because
they'd need the history.

## Roadmap / good next tasks
1. **Animated word-by-word captions** — build an `.ass` subtitle file from Whisper word timestamps, burn with ffmpeg. Biggest quality win.
2. **Face detection** — `trackSubject` follows a speaker across a clip by
   motion energy, which is enough for someone who walks or leans but knows
   nothing about faces. With two people it follows whoever moved last. Real
   active-speaker detection would pick whoever is *talking*.
3. **Finish billing** — the integration is built and inert. It needs Stripe
   products, four env vars, a webhook endpoint, and one real test-mode purchase.
4. **Real platform posting** — replace the simulated publisher in `src/scheduler.js`
   with TikTok/IG/YouTube API calls. This is what makes autopilot actually autopilot.
5. **A real database** — job state and accounts are JSON files behind a
   debounced write. Fine for one box; not fine for two.

Clip files are swept after `CLIP_RETENTION_DAYS` (default 30) — see
`sweepOldClips` in `src/reels.js`.

## Billing (`src/billing.js`)
Stripe hosted Checkout: the customer pays on Stripe's own page, so no card
details reach this server and we stay out of PCI scope. Cancelling and card
changes go to Stripe's billing portal rather than screens we would have to
build and secure.

Everything is inert until `STRIPE_SECRET_KEY` and the two price ids are set, so
an unconfigured deployment behaves exactly as before. What still needs doing:
create the products in Stripe, set the four env vars, point a webhook at
`/api/billing/webhook`, and run one real test-mode purchase end to end. It has
been checked against forged webhooks and the unconfigured path; it has never
taken a real payment.

The plan changes only when the **webhook** says the subscription is live. The
browser returning from checkout proves nothing — it can be faked, or never
arrive because someone closed the tab. `POST /api/plan` still lets you switch
tiers freely while billing is off (useful for trying them), and refuses any paid
tier the moment `STRIPE_SECRET_KEY` exists, or it would be a free upgrade for
anyone who opens devtools.

The webhook route is mounted **before** `express.json()` because Stripe signs
the raw bytes.

## Legal pages
`public/privacy.html` and `public/terms.html`, linked from every footer and
from the signup form. Stripe will not process live payments without both, and
TikTok, Instagram and YouTube all require them for their API applications — one
piece of work unblocking three things.

They describe what the app actually does: scrypt-hashed passwords, transcripts
kept because the catalogue miner searches them, clips swept at 30 days, card
data never touching our servers, the ownership confirmation. Keep them true —
a privacy policy that describes a different product is worse than none.

**They have not been reviewed by a lawyer.** They are written to be accurate
and readable, not to be litigated. Get them looked at before taking real money.

## Trial, not a free tier
Everyone signs up onto `trial`: the full Creator product for `TRIAL_DAYS`, with
120 credits — two hours of video, enough to judge it. No card. A trial that
hides the good parts only demonstrates the bad ones.

There is no permanent free plan. `free` is the *lapsed* state an account falls
to when the trial ends: the library stays readable, generating stops with a
message that says why. `activePlan(user)` does that transition on read, so
every caller — the clip route, autopilot, the scheduler, the catalogue — sees
one answer without each remembering to check a date.

The old free tier gave 45 unwatermarked credits a month forever, which is more
generous than Opus (60 credits, watermarked, deleted after 3 days) and cost
~$0.43 per signup with nothing pushing anyone to pay.

## Credits and margin (`src/credits.js`)
One credit is one minute of source video. Narrated formats cost extra per clip
because they make extra model calls — `creditsFor()` is the single definition.

`src/credits.js` holds the whole cost model: provider rates, an infrastructure
allocation, and `TARGET_MARGIN`. Plan allowances are derived from it, so a plan
can never promise more than the margin allows. Change the margin and the
numbers move together.

The first version of this counted Whisper alone and set 1200/3000 minutes. Once
compute, egress, storage and the narration extras are included the real figure
is ~$0.0096 a credit, which made those plans a 39% margin business. They are
600 and 1500 credits now, at 70%.

`userMargin()` answers the question the allowance number does not: what one
subscriber is worth. The plan allowance is sized to the *worst* case — someone
who spends every credit — which is 64-67% once Stripe's cut is included. A
realistic subscriber uses well under half and lands in the low 80s. Payment
fees matter more than they look on a $19 plan: the flat 30c is most of it.

Running out puts the account **on hold**: the library stays readable, generating
stops, autopilot says so in its log rather than failing quietly. The monthly
allowance resets; bought credits never expire and are spent only after the
allowance is gone.


## Jobs and the queue
`MAX_CONCURRENT_JOBS` (default 1) caps parallel renders. ffmpeg and Whisper will
each happily take a whole box, so three simultaneous runs on one server serve
nobody well. Waiting jobs report `queued` position and the UI says so rather
than showing a stalled progress bar.

Job state is written through to `.data/jobs.json`. The handles (AbortController,
child processes) can't be serialised, so on boot anything left "running" is
marked `MIR-RESTART` — a deploy used to kill a run and leave the page waiting
for progress that would never arrive.

## Before committing HTML changes
`npm run check` verifies every page's block tags balance. It exists because a
regex rewrite of the nav once matched past its intended end and swallowed a
page's `</nav>`, its `<header class="hero">` and a whole reel-wall column —
across six files. Every page still returned 200 and `node --check` was happy,
because malformed HTML is not a syntax error: the browser silently reparents
the wreckage and the layout collapses.

Rewriting a block of markup with `[\s\S]*?` is the specific trap. Prefer
slicing between located indices, and run the check after.

## Conventions
- Keep the pipeline modular (one function per stage) so stages can be swapped.
- Ownership is confirmed once per account before the first run (`ownershipAckAt`),
  and enforced server-side in `POST /api/clip`.
- Cap clips per run via `MAX_CLIPS` to control API cost.
