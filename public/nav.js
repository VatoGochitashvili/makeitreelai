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
