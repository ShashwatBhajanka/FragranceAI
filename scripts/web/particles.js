/* Drifting scent: mist, bubbles, motes and a few petals rising slowly behind the page.
   Deliberately faint. Reads its colours from the current paper so it follows the Style picker. */
(() => {
  const canvas = document.getElementById("scent");
  if (!canvas) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  if (reduce.matches) { canvas.remove(); return; }
  const ctx = canvas.getContext("2d");
  const root = document.documentElement;
  let W = 0, H = 0, dpr = 1, parts = [], last = 0, raf = 0, tone;

  const rnd = (a, b) => a + Math.random() * (b - a);

  function readTone() {
    const dark = root.dataset.bg === "noir";
    const cs = getComputedStyle(root);
    tone = {
      dark,
      accent: cs.getPropertyValue("--accent").trim() || "#8a3235",
      mist: dark ? "220,180,120" : "255,250,238",
      bubble: dark ? "239,227,204" : "120,80,40",
      petal: dark ? "220,174,111" : (root.dataset.bg === "blush" ? "190,90,110" : "170,110,70"),
      mote: dark ? "230,190,130" : "160,110,50",
    };
  }

  function make(kind, fresh) {
    const p = { kind, x: rnd(0, W), phase: rnd(0, 6.28), sway: rnd(8, 28), swaySpeed: rnd(0.15, 0.4) };
    p.y = fresh ? rnd(0, H) : H + rnd(20, 160);
    if (kind === "mist") { p.r = rnd(70, 160); p.vy = rnd(5, 11); p.a = rnd(0.07, 0.13); p.grow = rnd(2, 5); }
    if (kind === "bubble") { p.r = rnd(3, 10); p.vy = rnd(12, 26); p.a = rnd(0.16, 0.30); }
    if (kind === "mote") { p.r = rnd(0.8, 2.2); p.vy = rnd(8, 20); p.a = rnd(0.2, 0.42); }
    if (kind === "petal") { p.r = rnd(4, 7); p.vy = rnd(9, 17); p.a = rnd(0.2, 0.36); p.rot = rnd(0, 6.28); p.spin = rnd(-0.6, 0.6); }
    return p;
  }

  function populate() {
    const k = Math.min(1.6, Math.max(0.5, (W * H) / (1440 * 900)));
    const mix = { mist: 5, bubble: 10, mote: 20, petal: 5 };
    parts = [];
    for (const [kind, n] of Object.entries(mix))
      for (let i = 0; i < Math.round(n * k); i++) parts.push(make(kind, true));
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    populate();
  }

  function draw(p, t) {
    // fade in near the bottom, out near the top, so nothing pops
    const edge = Math.min(1, Math.max(0, (H - p.y) / 120)) * Math.min(1, Math.max(0, p.y / 160));
    const a = p.a * edge;
    if (a <= 0.003) return;
    const x = p.x + Math.sin(t * p.swaySpeed + p.phase) * p.sway;
    if (p.kind === "mist") {
      const g = ctx.createRadialGradient(x, p.y, 0, x, p.y, p.r);
      g.addColorStop(0, `rgba(${tone.mist},${a})`);
      g.addColorStop(1, `rgba(${tone.mist},0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, p.y, p.r, 0, 6.283); ctx.fill();
    } else if (p.kind === "bubble") {
      ctx.strokeStyle = `rgba(${tone.bubble},${a})`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, p.y, p.r, 0, 6.283); ctx.stroke();
      ctx.fillStyle = `rgba(${tone.bubble},${a * 0.12})`; ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${a * 1.6})`;
      ctx.beginPath(); ctx.arc(x - p.r * 0.35, p.y - p.r * 0.35, Math.max(0.8, p.r * 0.18), 0, 6.283); ctx.fill();
    } else if (p.kind === "mote") {
      ctx.fillStyle = `rgba(${tone.mote},${a})`;
      ctx.beginPath(); ctx.arc(x, p.y, p.r, 0, 6.283); ctx.fill();
    } else {
      ctx.save();
      ctx.translate(x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = `rgba(${tone.petal},${a})`;
      ctx.beginPath(); ctx.ellipse(0, 0, p.r, p.r * 0.55, 0, 0, 6.283); ctx.fill();
      ctx.restore();
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    const t = now / 1000;
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      p.y -= p.vy * dt;
      if (p.kind === "mist") p.r += p.grow * dt;
      if (p.kind === "petal") p.rot += p.spin * dt;
      if (p.y < -p.r * 2) parts[i] = make(p.kind, false);
      else draw(p, t);
    }
  }

  function start() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  function stop() { cancelAnimationFrame(raf); raf = 0; }

  readTone(); resize(); start();
  addEventListener("resize", resize);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  new MutationObserver(readTone).observe(root, { attributes: true, attributeFilter: ["data-bg"] });
  reduce.addEventListener?.("change", (e) => { if (e.matches) { stop(); canvas.remove(); } });
})();
