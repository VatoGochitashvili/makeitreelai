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
