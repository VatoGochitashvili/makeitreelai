// The tool, shared by every page that offers it.
//
// Four pages load this: the three single-purpose home pages (YouTube, Podcast,
// Upload) and the Studio. They all carry the same markup so nothing here has
// to guard against a missing element — what differs is which source block is
// visible, and that comes from <body data-source="...">.
//
// Bits that only exist in the Studio (the plan strip, the autopilot panel) are
// switched on by data attributes on <body> instead of being copied per page.


/* ---------- the generator tool ---------- */
// The home pages ship without the settings panel — one link, one button, and
// the defaults do the rest. Rather than guard forty call sites against a null,
// hand out a detached stand-in carrying the value that control would have had:
// reads get sensible defaults, writes and listeners go nowhere visible.
const SETTINGS_STANDINS = {
  settings: ["details", ""], setClips: ["select", "5"], setLength: ["select", "auto"],
  setCapStyle: ["select", "bold"], setCapPos: ["select", "top"], setCapSize: ["select", "medium"],
  setLayout: ["select", "balanced"], setMotion: ["select", "subtle"], setFormat: ["select", "clip"],
  setBackground: ["select", ""], setSum: ["span", ""], capPreview: ["div", ""], capSample: ["span", ""],
  bgPicker: ["div", ""], bgAdd: ["button", ""], bgFile: ["input", ""], bgNote: ["div", ""],
  voToggle: ["input", ""], voVoice: ["select", "alloy"], voLock: ["a", ""], voSwitch: ["label", ""],
  voSample: ["button", ""], voSampleTxt: ["span", ""], goBottom: ["button", ""],
};
const standins = new Map();
const $ = (id) => {
  const el = document.getElementById(id);
  if (el) return el;
  const spec = SETTINGS_STANDINS[id];
  if (!spec) return null;
  if (!standins.has(id)) {
    const node = document.createElement(spec[0]);
    if (spec[1]) {
      // a <select> only reports a value it actually holds
      if (spec[0] === "select") node.add(new Option(spec[1], spec[1]));
      node.value = spec[1];
    }
    standins.set(id, node);
  }
  return standins.get(id);
};
const go = $("go"), urlInput = $("url"), panel = $("panel"), logEl = $("log"),
      statusText = $("statusText"), spin = $("spin"), clipsEl = $("clips"),
      loginGate = $("loginGate"), toolMain = $("toolMain"), toolMeta = $("toolMeta"),
      voToggle = $("voToggle"), voVoice = $("voVoice"), voLock = $("voLock"), voSwitch = $("voSwitch");

let ME = null;              // { user, plan, usage }
let currentJobId = null;    // the job the Stop button acts on
// Bumped whenever a new poll loop starts; older loops see a stale token and
// stop, so two loops can never drive the same progress bar.
let pollToken = 0;
let restoreSettings = null; // settings chosen before signing up

// Decide login-gated vs ready, and configure the plan-specific controls.
async function initTool() {
  try {
    const r = await fetch("/api/me");
    ME = await r.json();
  } catch (_) { ME = { user: null }; }

  // The tool is always visible — anyone can paste a link and preview it.
  // Login is only required at the moment they hit "Make my reels".
  const signedIn = !!(ME && ME.user);
  loginGate.style.display = signedIn ? "none" : "flex";
  toolMain.style.display = "block";
  // The plan strip is workspace furniture — useful in the Studio, noise on a
  // marketing page. Pages opt in with <body data-plan-meta="on">.
  const wantMeta = signedIn && document.body.dataset.planMeta === "on";
  toolMeta.style.display = wantMeta ? "" : "none";
  go.textContent = signedIn ? "Make my reels" : "Make my reels →";
  if (wantMeta) renderMeta();

  // If the visitor arrived via the hero bar (or finished signup), restore
  // the link and any settings they had chosen before signing up.
  const pending = localStorage.getItem("mir_pendingUrl");
  if (pending) {
    localStorage.removeItem("mir_pendingUrl");
    urlInput.value = pending;
    document.getElementById("try").scrollIntoView({ behavior: "smooth" });
  }
  const pendingSet = localStorage.getItem("mir_pendingSettings");
  if (pendingSet) {
    localStorage.removeItem("mir_pendingSettings");
    try {
      const ps = JSON.parse(pendingSet);
      restoreSettings = ps; // applied after the controls are built below
    } catch (_) {}
  }

  // Voiceover is a paid capability (and needs an account at all).
  const canVoice = !!(ME.plan && ME.plan.voiceover);
  voToggle.disabled = !canVoice;
  voVoice.disabled = !canVoice || !voToggle.checked;
  voLock.style.display = canVoice ? "none" : "inline-flex";
  if (!signedIn) { voLock.textContent = "🔒 Sign up to use AI voiceover"; voLock.href = "/register.html"; }
  voSwitch.classList.toggle("locked", !canVoice);
  voToggle.addEventListener("change", () => { voVoice.disabled = !voToggle.checked; updateSetSum(); });

  // Clip-count choices are capped by the plan (signed-out visitors see the Free tier).
  const max = (ME.plan && ME.plan.clipsPerVideo) || 3;
  const sel = $("setClips");
  sel.innerHTML = Array.from({ length: max }, (_, i) => i + 1)
    .map((n) => `<option value="${n}"${n === max ? " selected" : ""}>${n} clip${n > 1 ? "s" : ""}</option>`).join("");

  if (ME.plan && ME.plan.maxUploadMB) {
    $("dropLimit").textContent = `mp4, mov, webm, mkv, mp3, wav · up to ${
      ME.plan.maxUploadMB >= 1024 ? (ME.plan.maxUploadMB / 1024) + " GB" : ME.plan.maxUploadMB + " MB"}`;
  }

  ["setClips", "setLength", "setCapStyle", "setCapPos", "setCapSize", "setMotion", "setLayout"].forEach((id) =>
    $(id).addEventListener("change", () => { renderCapPreview(); updateSetSum(); }));

  // Re-apply anything chosen before signing up.
  if (restoreSettings) {
    const r = restoreSettings; restoreSettings = null;
    if (r.clips && $("setClips").querySelector(`option[value="${r.clips}"]`)) $("setClips").value = r.clips;
    if (r.length) $("setLength").value = r.length;
    if (r.caption) {
      $("setCapStyle").value = r.caption.style;
      $("setCapPos").value = r.caption.position;
      $("setCapSize").value = r.caption.size;
    }
    if (r.voiceover && canVoice) { voToggle.checked = true; voVoice.disabled = false; }
    if (r.voice) voVoice.value = r.voice;
    if (r.motion) $("setMotion").value = r.motion;
    if (r.layout) $("setLayout").value = r.layout;
    $("settings").open = true;
  }

  renderCapPreview(); updateSetSum();
  if (signedIn) { loadBackgroundList(); if ($("autoCard")) initAutopilot(); }
  if (urlInput.value.trim()) loadPreview(normalizeLink(urlInput.value));

}

// Just the usage counter — poll() calls this when a run ends. It must not do
// the rest of initTool()'s work, which is page setup and only valid once.
async function refreshUsage() {
  try { ME = await (await fetch("/api/me")).json(); } catch (_) { return; }
  if (ME && ME.user && document.body.dataset.planMeta === "on") renderMeta();
}

// Re-attach to a run that is still going on the server after the tab was
// closed or reloaded.
//
// This deliberately lives outside initTool(): poll() calls initTool() when a
// run ends to refresh the usage counter, and while the reattach lived in there
// each finished run started another poll loop, which started another... The
// page ended up polling the same job five times at once and the progress bar
// sat at "Starting… 0%" while they fought each other.
let resumeChecked = false;
async function resumeRunningJob() {
  if (resumeChecked || !(ME && ME.user)) return;
  resumeChecked = true;
  try {
    const { jobs } = await (await fetch("/api/jobs/mine")).json();
    if (!jobs || !jobs.length) return;
    const j = jobs[0];
    currentJobId = j.id;
    panel.classList.add("show");
    $("errBox").style.display = "none";
    $("progWrap").style.display = "block";
    $("stopBtn").style.display = "inline-block";
    $("stopBtn").disabled = false;
    $("stopBtn").textContent = "Stop";
    spin.style.display = "inline-block";
    go.disabled = true; $("goFile").disabled = true;
    $("progHint").textContent = "Picked this run back up — it kept going while you were away.";
    poll(j.id);
  } catch (_) { /* nothing running */ }
}


// ---------- autopilot ----------
// The whole point is that this runs without anyone here, so the UI is mostly
// a window onto what the server already did.
let autoFeed = null;

function hourLabel(h) {
  const ampm = h < 12 ? "am" : "pm";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}:00 ${ampm}`;
}

async function initAutopilot() {
  let data;
  try { data = await (await fetch("/api/autopilot")).json(); } catch (_) { return; }
  if (!data.enabled) return;                 // Free plan — panel stays hidden
  $("autoCard").style.display = "block";

  // Fill the pickers once.
  const clipsSel = $("autoClips");
  if (!clipsSel.options.length) {
    const cap = (ME.plan && ME.plan.clipsPerVideo) || 3;
    for (let n = 1; n <= cap; n++) clipsSel.add(new Option(`${n} clip${n > 1 ? "s" : ""}`, n));
    for (let h = 0; h < 24; h++) $("autoHour").add(new Option(hourLabel(h), h));
  }

  autoFeed = data.feed;
  paintAutopilot();
}

function paintAutopilot() {
  const connected = !!autoFeed;
  $("autoSetup").style.display = connected ? "none" : "block";
  $("autoLive").style.display = connected ? "block" : "none";
  $("autoTitle").textContent = connected ? "Autopilot" : "Let your episodes clip themselves";
  if (!connected) { $("autoState").textContent = ""; return; }

  const f = autoFeed;
  $("autoState").textContent = f.active ? "● Watching" : "❚❚ Paused";
  $("autoState").className = "auto-state " + (f.active ? "on" : "off");
  $("autoShow").textContent = f.show || "Your podcast";
  $("autoArt").src = f.artwork || "";
  $("autoArt").style.display = f.artwork ? "block" : "none";
  $("autoLast").textContent = f.lastError
    ? `⚠ ${f.lastError}`
    : f.lastCheck ? `Last checked ${timeAgo(f.lastCheck)}` : "Checking shortly…";

  $("autoClips").value = f.settings.clips;
  $("autoLength").value = f.settings.length;
  $("autoHour").value = f.settings.postHour;
  $("autoPost").checked = f.settings.autoPost;
  $("autoPlats").querySelectorAll("input").forEach((i) => {
    i.checked = f.settings.platforms.includes(i.value);
  });
  $("autoPause").textContent = f.active ? "Pause" : "Resume";

  $("autoLog").innerHTML = (f.history || []).map((h) => `
    <div class="auto-ev ${h.kind || ""}">
      <span class="auto-ev-t">${timeAgo(h.at)}</span>
      <span>${escapeHtml(h.msg)}</span>
    </div>`).join("") || `<div class="auto-ev">Nothing has happened yet — that's the idea.</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function timeAgo(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function autoSettings() {
  return {
    clips: parseInt($("autoClips").value, 10),
    length: $("autoLength").value,
    postHour: parseInt($("autoHour").value, 10),
    autoPost: $("autoPost").checked,
    platforms: [...$("autoPlats").querySelectorAll("input:checked")].map((i) => i.value),
  };
}

async function saveAutopilot(body, errEl) {
  const el = $(errEl);
  el.textContent = "";
  try {
    const res = await fetch("/api/autopilot", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { el.textContent = data.error || "That didn't work."; return false; }
    autoFeed = data.feed;
    paintAutopilot();
    return true;
  } catch (_) {
    el.textContent = "Couldn't reach the server.";
    return false;
  }
}

// Autopilot only exists in the Studio; the home pages have no panel to wire.
if ($("autoCard")) {
  $("autoForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button");
    btn.disabled = true; btn.textContent = "Reading feed…";
    await saveAutopilot({ feedUrl: $("autoFeed").value.trim(), settings: autoSettings() }, "autoErr");
    btn.disabled = false; btn.textContent = "Connect feed";
  });

  $("autoSave").addEventListener("click", async () => {
    const btn = $("autoSave");
    btn.disabled = true;
    const ok = await saveAutopilot({ settings: autoSettings() }, "autoErr2");
    btn.textContent = ok ? "Saved ✓" : "Save";
    setTimeout(() => { btn.textContent = "Save"; btn.disabled = false; }, 1600);
  });

  $("autoPause").addEventListener("click", () =>
    saveAutopilot({ active: !autoFeed.active }, "autoErr2"));

  $("autoCheck").addEventListener("click", async () => {
    const btn = $("autoCheck");
    btn.disabled = true; btn.textContent = "Checking…";
    try {
      const res = await fetch("/api/autopilot/check", { method: "POST" });
      const data = await res.json();
      if (res.ok) { autoFeed = data.feed; paintAutopilot(); }
      else $("autoErr2").textContent = data.error || "Couldn't read the feed.";
    } catch (_) { $("autoErr2").textContent = "Couldn't reach the server."; }
    btn.disabled = false; btn.textContent = "Check now";
  });

  $("autoDrop").addEventListener("click", async () => {
    if (!confirm(`Stop watching "${autoFeed.show}"? Clips you've already made are kept.`)) return;
    await fetch("/api/autopilot", { method: "DELETE" });
    autoFeed = null;
    paintAutopilot();
  });
}

// ---------- generation settings ----------
// ---------- gameplay backgrounds (split screen / brainrot) ----------
// The footage isn't ours to ship, so the library is whatever the user adds.
let backgrounds = [];

async function loadBackgroundList() {
  try {
    const { backgrounds: list } = await (await fetch("/api/backgrounds")).json();
    backgrounds = list || [];
  } catch (_) { backgrounds = []; }
  const sel = $("setBackground");
  const keep = sel.value;
  sel.innerHTML = backgrounds.length
    ? backgrounds.map((b) => `<option value="${b.id}">${b.name}${b.duration ? ` — ${fmtTime(b.duration)}` : ""}</option>`).join("")
    : `<option value="">No footage yet — add one</option>`;
  if (keep && backgrounds.some((b) => b.id === keep)) sel.value = keep;
  updateBgPicker();
}

function updateBgPicker() {
  const fmt = $("setFormat").value;
  const needs = fmt === "split" || fmt === "brainrot";
  $("bgPicker").style.display = needs ? "block" : "none";
  if (!needs) return;
  $("bgNote").textContent = backgrounds.length
    ? (fmt === "brainrot"
        ? "The clip's audio is replaced by an AI voice reading a rewritten script — the original video never appears."
        : "Your clip plays on top, this footage plays underneath, and the original audio is kept.")
    : "Add a gameplay clip you recorded or are licensed to use. It gets cropped to 9:16 and looped.";
}

$("bgAdd").addEventListener("click", () => $("bgFile").click());
$("bgFile").addEventListener("change", async () => {
  const f = $("bgFile").files[0];
  if (!f) return;
  const note = $("bgNote");
  note.textContent = `Uploading ${f.name}…`;
  try {
    const res = await fetch(`/api/backgrounds?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
    const data = await res.json();
    if (!res.ok) { note.textContent = data.error || "That upload failed."; return; }
    await loadBackgroundList();
    $("setBackground").value = data.background.id;
    note.textContent = `Added "${data.background.name}".`;
  } catch (e) {
    note.textContent = "That upload failed — check the file and try again.";
  } finally {
    $("bgFile").value = "";
  }
});

$("setFormat").addEventListener("change", () => {
  updateBgPicker();
  updateSetSum();
  // Brainrot supplies its own narration; a second voiceover would double it.
  const brainrot = $("setFormat").value === "brainrot";
  voSwitch.classList.toggle("dimmed", brainrot);
  if (brainrot) voToggle.checked = false;
});
$("setBackground").addEventListener("change", updateSetSum);

function currentSettings() {
  const out = {
    clips: parseInt($("setClips").value, 10),
    length: $("setLength").value,
    caption: { style: $("setCapStyle").value, position: $("setCapPos").value, size: $("setCapSize").value },
    motion: $("setMotion").value,
    layout: $("setLayout").value,
    format: $("setFormat").value,
    backgroundId: $("setBackground").value || null,
    voiceover: !voToggle.disabled && voToggle.checked,
    voice: voVoice.value,
  };
  // Only send a range when it isn't the whole video.
  if (rangeSel && videoDuration && (rangeSel.start > 0 || rangeSel.end < videoDuration - 1)) {
    out.range = { start: Math.round(rangeSel.start), end: Math.round(rangeSel.end) };
  }
  return out;
}

function updateSetSum() {
  const s = currentSettings();
  const capLabel = { bold: "Bold", highlight: "Highlight", minimal: "Minimal", none: "No captions" }[s.caption.style];
  const lenLabel = { auto: "Auto (varied)", short: "15–30s", medium: "30–45s", long: "45–75s" }[s.length];
  const rangeLabel = s.range ? ` · ✂️ ${fmtTime(s.range.start)}–${fmtTime(s.range.end)}` : "";
  const fmtLabel = { clip: "", split: " · 🎮 Split screen", brainrot: " · 🎮 Brainrot" }[s.format] || "";
  $("setSum").textContent = `${s.clips} clip${s.clips > 1 ? "s" : ""} · ${lenLabel} · ${capLabel}${fmtLabel}${s.voiceover && s.format !== "brainrot" ? " · 🔊 Voiceover" : ""}${rangeLabel}`;
}

// Live mock of how the burned-in caption will look.
function renderCapPreview() {
  const box = $("capPreview"), sample = $("capSample");
  const style = $("setCapStyle").value, pos = $("setCapPos").value, size = $("setCapSize").value;
  box.className = "cap-preview pos-" + pos;
  sample.className = "cap-" + style + " size-" + size;
  sample.style.display = style === "none" ? "none" : "inline";
}

// ---------- YouTube link preview + interval picker ----------
let previewTimer, ytPlayer, videoDuration = 0, rangeSel = null, playheadTimer;
let currentYtId = null, lastDuration = 0; // remember a video's duration so it never downgrades to "whole video"
let rangeMode = "custom"; // "custom" (free ends) | "full" (whole video) | number (locked window width, seconds)

function ytId(u) {
  const m = String(u).match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s2 = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s2).padStart(2, "0")}`
           : `${m}:${String(s2).padStart(2, "0")}`;
}

// Load the YouTube IFrame API once, so we can seek the player as handles move.
let ytApiPromise;
function loadYTApi() {
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve(window.YT);
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const t = document.createElement("script");
    t.src = "https://www.youtube.com/iframe_api";
    t.onerror = () => resolve(null); // offline / blocked — fall back to a plain iframe
    document.head.appendChild(t);
    setTimeout(() => resolve(window.YT || null), 6000);
  });
  return ytApiPromise;
}

async function playInline(id) {
  const stage = $("pvStage");
  stage.classList.add("playing");
  const YT = await loadYTApi();
  if (YT && YT.Player) {
    ytPlayer = new YT.Player("ytPlayer", {
      videoId: id,
      playerVars: { autoplay: 1, start: Math.floor(rangeSel ? rangeSel.start : 0), rel: 0 },
      events: {
        onReady: (e) => {
          // Prefer the player's duration if yt-dlp didn't give us one.
          const d = e.target.getDuration();
          if (d && !videoDuration) { videoDuration = d; lastDuration = d; setupRange(); }
          trackPlayhead();
        },
      },
    });
  } else {
    document.getElementById("ytPlayer").outerHTML =
      `<iframe id="ytPlayer" src="https://www.youtube.com/embed/${id}?autoplay=1&start=${Math.floor(rangeSel ? rangeSel.start : 0)}"
        title="Video preview" frameborder="0" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
  }
}

// Move a marker along the track showing where playback currently is.
function trackPlayhead() {
  clearInterval(playheadTimer);
  playheadTimer = setInterval(() => {
    if (!ytPlayer || !ytPlayer.getCurrentTime || !videoDuration) return;
    const pct = (ytPlayer.getCurrentTime() / videoDuration) * 100;
    const ph = $("rgPlayhead");
    ph.style.left = Math.min(100, Math.max(0, pct)) + "%";
    ph.style.display = "block";
  }, 500);
}

// ---------- range selector ----------
function setupRange() {
  if (!videoDuration && lastDuration) videoDuration = lastDuration; // don't lose a known duration
  if (!videoDuration) {
    $("rangeWrap").style.display = "none";
    $("pvNoRange").style.display = "block";
    rangeSel = null;
    return;
  }
  $("pvNoRange").style.display = "none";
  $("rangeWrap").style.display = "block";
  $("pvDur").textContent = fmtTime(videoDuration) + " long";
  $("rgTotal").textContent = fmtTime(videoDuration);

  renderPresets();

  // Default: long videos start on a locked window so nobody transcribes hours
  // by accident; short ones default to the whole thing.
  if (videoDuration > 25 * 60) applyPreset(20 * 60);
  else if (videoDuration > 90) applyPreset("custom", { start: 0, end: videoDuration });
  else applyPreset("full");
}

// Fixed-length "bracket" presets — only offer ones shorter than the video.
function renderPresets() {
  const chips = [];
  [5, 15, 20, 30].forEach((m) => {
    if (m * 60 < videoDuration - 5) chips.push({ label: m + " min", mode: m * 60 });
  });
  chips.push({ label: "Custom", mode: "custom" });
  chips.push({ label: "Full video", mode: "full" });
  $("rgPresets").innerHTML = chips.map((c) =>
    `<button type="button" class="rg-chip" data-mode="${c.mode}">${c.label}</button>`).join("");
  $("rgPresets").querySelectorAll(".rg-chip").forEach((b) => b.addEventListener("click", () => {
    const raw = b.dataset.mode;
    applyPreset(raw === "custom" || raw === "full" ? raw : Number(raw));
  }));
}

function markActivePreset() {
  $("rgPresets").querySelectorAll(".rg-chip").forEach((b) => {
    const raw = b.dataset.mode;
    const m = raw === "custom" || raw === "full" ? raw : Number(raw);
    b.classList.toggle("active", m === rangeMode);
  });
}

function applyPreset(mode, keep) {
  rangeMode = mode;
  const wrap = $("rangeWrap");

  if (mode === "full") {
    rangeSel = { start: 0, end: videoDuration };
    wrap.classList.add("locked");            // hide the end/start handles
    wrap.classList.remove("windowed");
    $("rgHint").textContent = "Clips from the whole video";
  } else if (mode === "custom") {
    rangeSel = keep || rangeSel || { start: 0, end: Math.min(videoDuration, 20 * 60) };
    wrap.classList.remove("locked", "windowed");
    $("rgHint").textContent = "Drag the ends — or the middle to slide it";
  } else {
    // Locked-width window: keep the same start, snap the width to the bracket.
    const width = Math.min(mode, videoDuration);
    let start = rangeSel ? rangeSel.start : 0;
    if (start + width > videoDuration) start = Math.max(0, videoDuration - width);
    rangeSel = { start, end: start + width };
    wrap.classList.add("locked", "windowed"); // handles hidden, window is draggable
    $("rgHint").textContent = "Drag the window to move it";
  }

  paintRange();
  markActivePreset();
  if (ytPlayer && ytPlayer.seekTo) ytPlayer.seekTo(rangeSel.start, true);
}

function paintRange() {
  if (!rangeSel || !videoDuration) return;
  const track = $("rgTrack");
  const w = track.clientWidth || 1;
  const HALF = 11; // keep handle centres inside the track so they never clip
  const aFrac = rangeSel.start / videoDuration;
  const bFrac = rangeSel.end / videoDuration;

  $("rgSel").style.left = (aFrac * 100) + "%";
  $("rgSel").style.width = ((bFrac - aFrac) * 100) + "%";
  $("rgH1").style.left = Math.min(w - HALF, Math.max(HALF, aFrac * w)) + "px";
  $("rgH2").style.left = Math.min(w - HALF, Math.max(HALF, bFrac * w)) + "px";

  $("rgStart").textContent = fmtTime(rangeSel.start);
  $("rgEnd").textContent = fmtTime(rangeSel.end);
  const len = rangeSel.end - rangeSel.start;
  $("rgLen").textContent = fmtTime(len) + " selected";
  $("rgLen").classList.toggle("warn", len < 10);
  updateSetSum();
}

// Resize handles (only active in custom mode).
function bindHandle(el, which) {
  const onDown = (ev) => {
    if (rangeMode !== "custom") return;
    ev.preventDefault();
    const track = $("rgTrack");
    const move = (e) => {
      const r = track.getBoundingClientRect();
      const x = ((e.touches ? e.touches[0].clientX : e.clientX) - r.left) / r.width;
      let t = Math.min(1, Math.max(0, x)) * videoDuration;
      if (which === "start") rangeSel.start = Math.min(t, rangeSel.end - 10);
      else rangeSel.end = Math.max(t, rangeSel.start + 10);
      rangeSel.start = Math.max(0, rangeSel.start);
      rangeSel.end = Math.min(videoDuration, rangeSel.end);
      paintRange();
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.removeEventListener("touchmove", move);
      document.removeEventListener("touchend", up);
      el.classList.remove("dragging");
      if (ytPlayer && ytPlayer.seekTo) {
        ytPlayer.seekTo(which === "start" ? rangeSel.start : Math.max(0, rangeSel.end - 3), true);
      }
    };
    el.classList.add("dragging");
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    document.addEventListener("touchmove", move, { passive: false });
    document.addEventListener("touchend", up);
  };
  el.addEventListener("mousedown", onDown);
  el.addEventListener("touchstart", onDown, { passive: false });
}
bindHandle($("rgH1"), "start");
bindHandle($("rgH2"), "end");

// Drag the whole selection to slide it (used for locked windows and custom).
(function bindSelDrag() {
  const sel = $("rgSel");
  const onDown = (ev) => {
    if (rangeMode === "full") return;
    // In custom mode the handles sit on the sel edges — let them win.
    if (ev.target.closest(".range-h")) return;
    ev.preventDefault();
    const track = $("rgTrack");
    const r = track.getBoundingClientRect();
    const startX = ev.touches ? ev.touches[0].clientX : ev.clientX;
    const s0 = rangeSel.start;
    const width = rangeSel.end - rangeSel.start;
    const move = (e) => {
      const x = e.touches ? e.touches[0].clientX : e.clientX;
      const dt = ((x - startX) / r.width) * videoDuration;
      let ns = Math.min(videoDuration - width, Math.max(0, s0 + dt));
      rangeSel = { start: ns, end: ns + width };
      paintRange();
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.removeEventListener("touchmove", move);
      document.removeEventListener("touchend", up);
      sel.classList.remove("grabbing");
      if (ytPlayer && ytPlayer.seekTo) ytPlayer.seekTo(rangeSel.start, true);
    };
    sel.classList.add("grabbing");
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    document.addEventListener("touchmove", move, { passive: false });
    document.addEventListener("touchend", up);
  };
  sel.addEventListener("mousedown", onDown);
  sel.addEventListener("touchstart", onDown, { passive: false });
})();

async function loadPreview(u) {
  const id = ytId(u);
  const pv = $("preview");
  if (!id) { pv.style.display = "none"; rangeSel = null; videoDuration = 0; return; }

  // Reset any previous player/selection. Keep lastDuration if it's the same
  // video, so a duplicate/slow response can't wipe an already-shown range.
  clearInterval(playheadTimer);
  if (id !== currentYtId) { currentYtId = id; lastDuration = 0; }
  ytPlayer = null; videoDuration = 0; rangeSel = null;
  $("pvStage").classList.remove("playing");
  $("pvStage").innerHTML =
    `<img id="pvImg" src="https://img.youtube.com/vi/${id}/maxresdefault.jpg"
        onerror="this.src='https://img.youtube.com/vi/${id}/hqdefault.jpg'" alt="">
     <div id="ytPlayer"></div>
     <button class="pv-play" id="pvPlay" title="Play video"></button>`;
  $("pvPlay").addEventListener("click", () => playInline(id));
  $("pvTitle").textContent = "Loading…";
  $("pvAuthor").textContent = ""; $("pvDur").textContent = "";
  $("rangeWrap").style.display = "none";
  pv.style.display = "block";

  try {
    const r = await fetch("/api/preview?url=" + encodeURIComponent(u));
    if (!r.ok) throw new Error();
    const d = await r.json();
    $("pvTitle").textContent = d.title || "Video";
    $("pvAuthor").textContent = d.author ? "by " + d.author : "";
    videoDuration = d.duration || 0;
    if (videoDuration) lastDuration = videoDuration;
    setupRange();
  } catch {
    $("pvTitle").textContent = "Video preview";
    $("pvAuthor").textContent = "";
    setupRange(); // no duration -> whole-video notice
  }
}

urlInput.addEventListener("input", () => {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => loadPreview(normalizeLink(urlInput.value)), 400);
});

function renderMeta() {
  const p = ME.plan, u = ME.usage;
  const left = u.videosPerMonth === -1
    ? "Unlimited videos"
    : `${Math.max(0, u.videosPerMonth - u.videos)} of ${u.videosPerMonth} videos left this month`;
  toolMeta.innerHTML =
    `<span class="meta-plan">${p.name} plan</span>` +
    `<span class="meta-dot">•</span><span>${p.clipsPerVideo} clips / video</span>` +
    `<span class="meta-dot">•</span><span>${p.resolution}p</span>` +
    `<span class="meta-dot">•</span><span>${left}</span>` +
    `<a class="meta-upgrade" href="/account.html">Manage plan →</a>`;
}

// NB: pass an explicit false — a bare listener would hand start() the click
// Event as its "fromUpload" argument, which is truthy and aborts the run.
go.addEventListener("click", () => start(false));
urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") start(false); });

// Users paste "youtube.com/watch?v=..." all the time — treat it like a browser does.
function normalizeLink(v) {
  const t = String(v || "").trim();
  if (!t) return "";
  return /^https?:\/\//i.test(t) ? t : "https://" + t;
}

async function start(fromUpload) {
  const url = normalizeLink(urlInput.value);

  // Say what's missing rather than doing nothing.
  if (fromUpload && !uploadId) return toolHint("Choose a file first — then press Make my reels.");
  if (!fromUpload && !url) {
    urlInput.focus();
    return toolHint(activeSource === "podcast"
      ? "Pick an episode from the list first."
      : "Paste a video link first — or switch to Upload a file.");
  }

  // Not signed in? Remember what they set up, then send them to sign up —
  // they land back here with the link and settings restored.
  if (!ME || !ME.user) {
    if (url) localStorage.setItem("mir_pendingUrl", url);
    localStorage.setItem("mir_pendingSettings", JSON.stringify(currentSettings()));
    location.href = "/register.html";
    return;
  }

  clipsEl.innerHTML = ""; logEl.textContent = ""; panel.classList.add("show");
  $("errBox").style.display = "none";
  $("progWrap").style.display = "block";
  shownPct = 0; targetPct = 2; etaShown = null; etaAt = 0; clearInterval(creepTimer); creepTimer = null;
  $("progEta").textContent = "estimating…";
  $("progFill").style.width = "2%";
  $("progHint").textContent = "This can take a few minutes — you can leave this tab open.";
  $("stopBtn").style.display = "inline-block"; $("stopBtn").disabled = false; $("stopBtn").textContent = "Stop";
  document.querySelectorAll(".pstep").forEach((el) => el.classList.remove("done", "active"));
  spin.style.display = "inline-block"; statusText.textContent = "Starting…";
  go.disabled = true; $("goFile").disabled = true;

  const body = fromUpload ? { uploadId, ...currentSettings() } : { url, ...currentSettings() };

  let jobId;
  currentJobId = null;
  try {
    const r = await fetch("/api/clip", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    if (r.status === 401) { loginGate.style.display = "block"; toolMain.style.display = "none"; return; }
    if (!r.ok) throw new Error((d.upgrade ? "⬆ " : "") + (d.error || "Failed to start"));
    jobId = currentJobId = d.jobId;
  } catch (err) { fail(err.message); return; }

  poll(jobId);
}

const STAGE_LABELS = {
  queued: "Getting started…",
  download: "Fetching your video…",
  transcribe: "Transcribing the audio…",
  moments: "AI is picking the best moments…",
  render: "Rendering your clips…",
  done: "Finishing up…",
};

// The server only reports at stage boundaries, so the raw number sits still
// and then jumps. Animate towards it instead, and keep creeping slowly while
// we wait so the bar always looks alive — but never overtake the real value's
// next milestone.
let shownPct = 0, targetPct = 0, creepTimer = null;
const STAGE_CEIL = { queued: 5, download: 30, transcribe: 56, moments: 60, render: 98, done: 100 };

function animateProgress() {
  clearInterval(creepTimer);
  creepTimer = setInterval(() => {
    if (shownPct < targetPct) {
      // catch up to real progress quickly
      shownPct += Math.max(0.15, (targetPct - shownPct) * 0.25);
    } else {
      // Caught up and the server hasn't moved yet — keep creeping towards this
      // stage's ceiling so a long step never looks frozen. Slows as it nears
      // the ceiling so it can't run away from reality.
      const room = Math.max(0, (ceilPct - 0.5) - shownPct);
      if (room > 0.05) shownPct += Math.max(0.02, room * 0.012);
    }
    shownPct = Math.min(shownPct, 100);
    $("progFill").style.width = shownPct.toFixed(1) + "%";
    $("progPct").textContent = Math.floor(shownPct) + "%";
    paintEta();
  }, 200);
}

let ceilPct = 100;

// Estimate remaining time from how long real progress has actually taken.
// Smoothed, and never allowed to jump upwards by much, so it doesn't flicker.
let etaShown = null, etaAt = 0;
function updateEta(pct, elapsedMs) {
  if (!elapsedMs || pct < 4) { etaShown = null; return; }
  const remaining = (elapsedMs / pct) * (100 - pct);
  etaShown = etaShown == null ? remaining : Math.min(etaShown * 1.15, etaShown * 0.75 + remaining * 0.25);
  etaAt = Date.now();
}

// Rendered on the animation timer so the estimate ticks down between polls
// instead of sitting on the same number for seconds at a time.
function paintEta() {
  const el = $("progEta");
  if (etaShown == null) { el.textContent = "estimating…"; return; }
  const left = etaShown - (Date.now() - etaAt);
  const secs = Math.max(5, Math.round(left / 1000));
  el.textContent = secs >= 90
    ? `about ${Math.round(secs / 60)} min left`
    : `about ${Math.max(5, Math.round(secs / 5) * 5)}s left`;
}

function paintProgress(d) {
  targetPct = Math.max(2, Math.min(100, d.progress || 0));
  updateEta(d.progress || 0, d.elapsedMs);
  ceilPct = STAGE_CEIL[d.stage] ?? 100;
  if (!creepTimer) animateProgress();

  let label = STAGE_LABELS[d.stage] || "Working…";
  if (d.stage === "render" && d.detail && d.detail.total) {
    label = `Rendering clip ${d.detail.current} of ${d.detail.total}…`;
  } else if (d.stage === "transcribe" && d.detail && d.detail.total) {
    label = `Transcribing part ${d.detail.current} of ${d.detail.total}…`;
  }
  statusText.textContent = label;

  // tick off the steps we've passed
  const order = ["download", "transcribe", "moments", "render"];
  const at = order.indexOf(d.stage);
  document.querySelectorAll(".pstep").forEach((el) => {
    const i = order.indexOf(el.dataset.stage);
    el.classList.toggle("done", d.stage === "done" || (at > -1 && i < at));
    el.classList.toggle("active", i === at);
  });
}

async function poll(jobId, token) {
  if (token === undefined) token = ++pollToken;   // a fresh loop supersedes any older one
  if (token !== pollToken) return;                // superseded — let this one die
  try {
    const r = await fetch("/api/jobs/" + jobId);
    const d = await r.json();
    logEl.textContent = d.logs.map((l) => l.msg).join("\n");
    logEl.scrollTop = logEl.scrollHeight;

    if (d.status === "running") {
      paintProgress(d);
      setTimeout(() => poll(jobId, token), 1500);
    } else if (d.status === "done") {
      paintProgress({ ...d, stage: "done", progress: 100 });
      clearInterval(creepTimer); creepTimer = null;
      $("progFill").style.width = "100%"; $("progPct").textContent = "100%";
      $("progEta").textContent = "";
      spin.style.display = "none";
      $("stopBtn").style.display = "none";
      statusText.textContent = "✅ " + d.clips.length + " clips ready!";
      $("progHint").textContent = "";
      go.disabled = false; $("goFile").disabled = !uploadId;
      renderClips(d.clips);
      refreshUsage();
    } else if (d.status === "cancelled") {
      clearInterval(creepTimer); creepTimer = null;
      spin.style.display = "none";
      $("stopBtn").style.display = "none";
      statusText.innerHTML = '<span style="color:var(--muted)">■ Stopped — you were not charged for this run.</span>';
      $("progHint").textContent = "";
      go.disabled = false; $("goFile").disabled = !uploadId;
      currentJobId = null;
      refreshUsage();
    } else {
      fail(d.error || "Something went wrong", d.errorCode, d.logs);
    }
  } catch (err) { setTimeout(() => poll(jobId, token), 2000); }
}

function renderClips(clips) {
  const canSchedule = !!(ME && ME.plan && ME.plan.scheduler);
  clipsEl.innerHTML = clips.map((c) => `
    <div class="clip">
      <video src="${c.url}" controls preload="metadata"></video>
      <div class="meta">
        <div class="badges">
          ${c.virality != null ? `<span class="v">🔥 ${c.virality}</span>` : ""}
          ${c.narrated ? `<span class="v narr">🎙️ Narrated</span>` : ""}
        </div>
        <div class="t">${c.title || "Clip"}</div>
        <a class="dl" href="${c.url}" download>Download</a>
        ${canSchedule ? `<a class="sched-clip" data-url="${c.url}" data-title="${(c.title || "Clip").replace(/"/g, "&quot;")}">📅 Schedule post</a>` : ""}
      </div>
    </div>`).join("");
  clipsEl.querySelectorAll(".sched-clip").forEach((b) => b.addEventListener("click", () => {
    localStorage.setItem("mir_scheduleClip", JSON.stringify({ url: b.dataset.url, title: b.dataset.title }));
    location.href = "/account.html#scheduler";
  }));
}

function fail(msg, code, logs) {
  clearInterval(creepTimer); creepTimer = null;
  spin.style.display = "none";
  $("stopBtn").style.display = "none";
  $("progWrap").style.display = "none";
  $("errBox").style.display = "block";
  $("errMsg").textContent = msg;
  $("errCode").textContent = code || "MIR-LOCAL";
  go.disabled = false; $("goFile").disabled = !uploadId;

  // Build one paste-able blob: code, message, and the last few log lines.
  const tail = (logs || []).slice(-12).map((l) => l.msg).join("\n");
  $("errCopy").onclick = async () => {
    const diag = [
      `build: ${BUILD}`,
      `page: ${location.pathname}`,
      `source tab: ${activeSource}`,
      `link field: ${urlInput.value ? "set" : "empty"}`,
      `uploadId: ${uploadId ? "set" : "none"}`,
      `signed in: ${!!(ME && ME.user)}`,
    ].join("\n");
    const text = `MakeItReel error\ncode: ${code || "MIR-LOCAL"}\nwhen: ${new Date().toISOString()}\nmessage: ${msg}\n\n--- context ---\n${diag}\n\n--- log ---\n${tail}`;
    try {
      await navigator.clipboard.writeText(text);
      $("errCopy").textContent = "✓ Copied";
      setTimeout(() => { $("errCopy").textContent = "Copy error details"; }, 2000);
    } catch {
      // clipboard blocked — drop it in the technical panel so it can be selected
      logEl.textContent = text;
      $("errCopy").textContent = "See technical details";
    }
  };
}


// ---------- file upload (the reliable source) ----------
let uploadId = null, uploadXhr = null, localObjectUrl = null;
let activeSource = document.body.dataset.source || "link"; // set per page; the Studio's tabs change it
let BUILD = "?";
fetch("/api/version").then((r) => r.json()).then((d) => { BUILD = d.build; }).catch(() => {});

// Small inline nudge under the tool instead of a silent no-op.
function toolHint(msg) {
  const el = $("toolHint");
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(toolHint._t);
  toolHint._t = setTimeout(() => { el.style.display = "none"; }, 4000);
}

function showSource(which) {
  activeSource = which;
  $("srcLink").style.display = which === "link" ? "block" : "none";
  $("srcFile").style.display = which === "file" ? "block" : "none";
  $("srcPodcast").style.display = which === "podcast" ? "block" : "none";
}
showSource(activeSource);

// Only the Studio offers all three behind tabs; the home pages each commit to
// one. Switching tabs doesn't destroy what you already entered — which source
// gets used is decided by the button you press.
document.querySelectorAll(".src-tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".src-tab").forEach((x) => x.classList.remove("active"));
  t.classList.add("active");
  showSource(t.dataset.src);
}));

// ---------- podcast feed ----------
$("feedGo").addEventListener("click", loadFeed);
$("feedUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") loadFeed(); });

async function loadFeed() {
  const feed = $("feedUrl").value.trim();
  const msg = $("feedMsg"), list = $("epList");
  if (!feed) { $("feedUrl").focus(); return; }
  msg.className = "auth-msg"; msg.textContent = "Loading episodes…"; list.innerHTML = "";
  try {
    const r = await fetch("/api/podcast?url=" + encodeURIComponent(feed));
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not read that feed");
    msg.className = "auth-msg ok"; msg.textContent = `${d.show} — ${d.episodes.length} episodes`;
    list.innerHTML = d.episodes.map((e, i) => `
      <button type="button" class="ep" data-i="${i}">
        <span class="ep-title">${e.title.replace(/</g, "&lt;")}</span>
        <span class="ep-meta">${e.duration ? fmtTime(e.duration) : ""}${e.date ? " · " + new Date(e.date).toLocaleDateString() : ""}</span>
      </button>`).join("");
    list.querySelectorAll(".ep").forEach((b) => b.addEventListener("click", () => {
      list.querySelectorAll(".ep").forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
      const ep = d.episodes[+b.dataset.i];
      // An episode is just a direct media URL — reuse the normal link flow.
      urlInput.value = ep.url;
      $("goPodcast").disabled = false;
      showEpisodePreview(ep);
    }));
  } catch (err) {
    msg.className = "auth-msg err"; msg.textContent = err.message;
  }
}

// Preview a chosen episode: audio player + the same interval picker.
function showEpisodePreview(ep) {
  const pv = $("preview");
  currentYtId = null; ytPlayer = null;
  videoDuration = ep.duration || 0; lastDuration = videoDuration; rangeSel = null;
  clearInterval(playheadTimer);

  $("pvStage").classList.add("playing");
  $("pvStage").innerHTML = `<div class="ep-art">🎙️<audio id="epAudio" src="${ep.url}" controls preload="metadata"></audio></div>`;
  $("pvTitle").textContent = ep.title;
  $("pvAuthor").textContent = "Podcast episode";
  pv.style.display = "block";

  const a = document.getElementById("epAudio");
  a.addEventListener("loadedmetadata", () => {
    if (a.duration && isFinite(a.duration)) { videoDuration = a.duration; lastDuration = a.duration; setupRange(); }
  });
  playheadTimer = setInterval(() => {
    if (!videoDuration || !a.duration) return;
    const ph = $("rgPlayhead");
    ph.style.left = Math.min(100, Math.max(0, (a.currentTime / videoDuration) * 100)) + "%";
    ph.style.display = "block";
  }, 500);

  setupRange();
}

const dropZone = $("dropZone"), fileInput = $("fileInput");
dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("over"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault(); dropZone.classList.remove("over");
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });
$("upClear").addEventListener("click", clearUpload);

function clearUpload() {
  if (uploadXhr) { uploadXhr.abort(); uploadXhr = null; }
  if (localObjectUrl) { URL.revokeObjectURL(localObjectUrl); localObjectUrl = null; }
  uploadId = null; fileInput.value = "";
  $("upFile").style.display = "none";
  $("goFile").disabled = true;
  $("preview").style.display = "none";
  videoDuration = 0; lastDuration = 0; rangeSel = null;
}

function handleFile(file) {
  clearUpload();
  $("upFile").style.display = "block";
  $("upName").textContent = file.name;
  $("upStatus").textContent = "Uploading… 0%";
  $("upFill").style.width = "0%";

  // Show a local preview + the interval picker immediately — no waiting for
  // the upload, since the browser can read the file directly.
  localObjectUrl = URL.createObjectURL(file);
  showLocalPreview(localObjectUrl, file.name);

  uploadXhr = new XMLHttpRequest();
  uploadXhr.open("POST", "/api/upload?name=" + encodeURIComponent(file.name));
  uploadXhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    $("upFill").style.width = pct + "%";
    $("upStatus").textContent = `Uploading… ${pct}%`;
  };
  const xhr = uploadXhr;
  xhr.onload = () => {
    uploadXhr = null;
    let d = {};
    try { d = JSON.parse(xhr.responseText || "{}"); } catch (_) {}
    if (xhr.status >= 200 && xhr.status < 300 && d.uploadId) {
      uploadId = d.uploadId;
      $("upFill").style.width = "100%";
      $("upStatus").textContent = "✓ Ready";
      $("upStatus").classList.add("ok");
      $("goFile").disabled = false;
      if (d.duration && !videoDuration) { videoDuration = d.duration; lastDuration = d.duration; setupRange(); }
    } else {
      $("upStatus").textContent = d.error || "Upload failed";
      $("upStatus").classList.add("err");
    }
  };
  xhr.onerror = () => { uploadXhr = null; $("upStatus").textContent = "Upload failed"; $("upStatus").classList.add("err"); };
  xhr.send(file);
}

// Preview an uploaded file with the same stage + interval picker.
function showLocalPreview(objUrl, name) {
  const pv = $("preview");
  currentYtId = null; ytPlayer = null; videoDuration = 0; lastDuration = 0; rangeSel = null;
  $("pvStage").classList.add("playing");
  $("pvStage").innerHTML = `<video id="localVideo" src="${objUrl}" controls preload="metadata"
      style="width:100%;height:100%;object-fit:contain;background:#000"></video>`;
  $("pvTitle").textContent = name;
  $("pvAuthor").textContent = "Your upload";
  pv.style.display = "block";

  const v = document.getElementById("localVideo");
  v.addEventListener("loadedmetadata", () => {
    if (v.duration && isFinite(v.duration)) {
      videoDuration = v.duration; lastDuration = v.duration;
      setupRange();
    }
  });
  // Keep the playhead marker in sync with the local player.
  clearInterval(playheadTimer);
  playheadTimer = setInterval(() => {
    if (!videoDuration || !v.duration) return;
    const ph = $("rgPlayhead");
    ph.style.left = Math.min(100, Math.max(0, (v.currentTime / videoDuration) * 100)) + "%";
    ph.style.display = "block";
  }, 500);
}

$("goFile").addEventListener("click", () => start(true));
$("goPodcast").addEventListener("click", () => start(false)); // episode URL is in urlInput

// The settings panel is long — offer the action at the bottom as well.
$("goBottom").addEventListener("click", () => start(activeSource === "file"));

document.getElementById("stopBtn").addEventListener("click", async () => {
  if (!currentJobId) return;
  const btn = $("stopBtn");
  btn.disabled = true; btn.textContent = "Stopping…";
  statusText.textContent = "Stopping…";
  try {
    await fetch(`/api/jobs/${currentJobId}/cancel`, { method: "POST" });
  } catch (_) { /* the poll will reflect it either way */ }
  setTimeout(() => { btn.disabled = false; btn.textContent = "Stop"; }, 3000);
});

initTool().then(resumeRunningJob);
