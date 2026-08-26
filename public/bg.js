// Minimal ambient background: a handful of slow-drifting motes.
// Deliberately sparse — it should read as depth, not decoration.
(function () {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return;

  const c = document.createElement("canvas");
  c.id = "bgfx";
  document.body.prepend(c);
  const ctx = c.getContext("2d", { alpha: true });

  let w, h, dots, dpr;
  function size() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = c.width = innerWidth * dpr;
    h = c.height = innerHeight * dpr;
    c.style.width = innerWidth + "px";
    c.style.height = innerHeight + "px";
    // density scales with the viewport, capped so it stays minimal
    const n = Math.min(46, Math.round((innerWidth * innerHeight) / 42000));
    dots = Array.from({ length: n }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: (Math.random() * 1.6 + 0.5) * dpr,
      vx: (Math.random() - 0.5) * 0.11 * dpr,
      vy: (Math.random() - 0.5) * 0.11 * dpr,
      a: Math.random() * 0.35 + 0.12,
      hue: Math.random() < 0.5 ? "124,92,255" : "255,92,168",
      t: Math.random() * Math.PI * 2,
    }));
  }
  size();
  addEventListener("resize", size);

  let raf;
  function frame() {
    ctx.clearRect(0, 0, w, h);
    for (const d of dots) {
      d.x += d.vx; d.y += d.vy; d.t += 0.006;
      if (d.x < -20) d.x = w + 20; else if (d.x > w + 20) d.x = -20;
      if (d.y < -20) d.y = h + 20; else if (d.y > h + 20) d.y = -20;
      const a = d.a * (0.65 + 0.35 * Math.sin(d.t));  // gentle breathing
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${d.hue},${a.toFixed(3)})`;
      ctx.fill();
    }
    raf = requestAnimationFrame(frame);
  }
  frame();

  // Don't burn cycles in a hidden tab. Guarded so repeated visibility
  // changes can't leave two loops running at once.
  let running = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      running = false;
      cancelAnimationFrame(raf);
    } else if (!running) {
      running = true;
      frame();
    }
  });
})();
