// Fade out before following an internal link, so moving between pages feels
// continuous instead of a hard white-to-dark blink.
(function () {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  document.addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (!a) return;
    const href = a.getAttribute("href");
    if (!href || a.target === "_blank" || a.hasAttribute("download")) return;
    if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
    // same-origin only
    const url = new URL(href, location.href);
    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.hash) return; // in-page anchor

    e.preventDefault();
    document.body.classList.add("leaving");
    setTimeout(() => { location.href = url.href; }, 200);
  });

  // Coming back via the back button should not leave the page faded out.
  window.addEventListener("pageshow", () => document.body.classList.remove("leaving"));
})();

// Arriving at "/#pricing" from another page can land short: the browser jumps
// to the anchor while the document is still settling, then late layout pushes
// the section further down. One correction once everything has loaded is
// enough — and it stops if the visitor scrolls first, because fighting them
// for control of the page is worse than a missed anchor.
(function () {
  if (!location.hash) return;
  const id = location.hash.slice(1);
  let stop = false;
  const give = () => { stop = true; };
  addEventListener("wheel", give, { passive: true, once: true });
  addEventListener("touchstart", give, { passive: true, once: true });
  addEventListener("keydown", give, { once: true });

  addEventListener("load", () => setTimeout(() => {
    if (stop) return;
    const target = document.getElementById(id);
    if (target) target.scrollIntoView({ block: "start", behavior: "instant" });
  }, 400));
})();


// Features mega-menu. Opens on hover for a mouse, on click for touch and
// keyboards — and the trigger stays a real link, so it still works if this
// script never runs.
(function () {
  const wrap = document.getElementById("featTrigger");
  if (!wrap) return;
  const trigger = wrap.querySelector(".feat-trigger");
  let closeTimer;

  const open = () => { clearTimeout(closeTimer); wrap.classList.add("open"); };
  const close = () => { closeTimer = setTimeout(() => wrap.classList.remove("open"), 140); };

  const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;
  if (finePointer) {
    wrap.addEventListener("mouseenter", open);
    wrap.addEventListener("mouseleave", close);
    wrap.addEventListener("focusin", open);
    wrap.addEventListener("focusout", close);
  }

  trigger.addEventListener("click", (e) => {
    // On touch the first tap opens the menu instead of navigating away.
    if (!finePointer && !wrap.classList.contains("open")) { e.preventDefault(); open(); }
  });

  addEventListener("keydown", (e) => { if (e.key === "Escape") wrap.classList.remove("open"); });
  document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) wrap.classList.remove("open"); });
})();
