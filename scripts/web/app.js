/* FragranceAI front end (tentative). Talks to scripts/server.py. */
(() => {
  const $ = (s) => document.querySelector(s);
  const log = $("#log"), scroller = $("#scroll"), input = $("#input"), sendBtn = $("#send");
  const form = $("#composer"), notice = $("#notice");

  let sessionId = newId();
  let busy = false;
  let controller = null;

  function newId() {
    return (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2);
  }

  /* ---------- small helpers ---------- */
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function nearBottom() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
  }
  function toBottom(force) {
    if (force || nearBottom()) scroller.scrollTop = scroller.scrollHeight;
  }

  /* ---------- minimal, safe markdown ---------- */
  function inline(raw) {
    const stash = [];
    const keep = (html) => "\u0000" + (stash.push(html) - 1) + "\u0000";
    let s = esc(raw);
    s = s.replace(/`([^`]+)`/g, (_, c) => keep("<code>" + c + "</code>"));
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) =>
      keep('<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + "</a>"));
    s = s.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g, (u) =>
      keep('<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + "</a>"));
    s = s.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i]);
  }

  function markdown(src) {
    const lines = src.replace(/\r/g, "").split("\n");
    const out = [];
    let i = 0;
    const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
    const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      if (/^```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push("<pre><code>" + esc(buf.join("\n")) + "</code></pre>");
        continue;
      }
      let m = line.match(/^(#{1,4})\s+(.*)$/);
      if (m) {
        const level = Math.min(Math.max(m[1].length + 1, 2), 4);
        out.push("<h" + level + ">" + inline(m[2]) + "</h" + level + ">");
        i++; continue;
      }
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push("<hr>"); i++; continue; }

      if (isRow(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]));
        out.push('<div class="tablewrap"><table><thead><tr>' + head.map((c) => "<th>" + inline(c) + "</th>").join("") +
          "</tr></thead><tbody>" + rows.map((r) => "<tr>" + r.map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>").join("") +
          "</tbody></table></div>");
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const items = [];
        const re = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
        while (i < lines.length) {
          const mm = lines[i].match(re);
          if (mm) { items.push(mm[1]); i++; }
          else if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += " " + lines[i].trim(); i++; }
          else break;
        }
        const tag = ordered ? "ol" : "ul";
        out.push("<" + tag + ">" + items.map((t) => "<li>" + inline(t) + "</li>").join("") + "</" + tag + ">");
        continue;
      }
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i]) && !isRow(lines[i])) buf.push(lines[i++]);
      if (!buf.length) { buf.push(lines[i++]); }
      out.push("<p>" + buf.map(inline).join("<br>") + "</p>");
    }
    return out.join("");
  }

  /* ---------- message rendering ---------- */
  function addUser(text) {
    const m = el("article", "msg user");
    const b = el("div", "body");
    b.textContent = text;
    m.appendChild(b);
    log.appendChild(m);
    toBottom(true);
  }

  function addThinking() {
    const m = el("article", "msg bot");
    m.setAttribute("aria-busy", "true");
    m.innerHTML =
      '<div class="thinking" role="status" aria-live="polite">' +
      '<div class="wisps" aria-hidden="true"><span></span><span></span><span></span></div>' +
      '<div><span class="text">Thinking it through</span><span class="slow" hidden>This one needs a few lookups, hang tight.</span></div></div>';
    log.appendChild(m);
    toBottom(true);
    const text = m.querySelector(".text"), slow = m.querySelector(".slow");
    const timer = setTimeout(() => { slow.hidden = false; }, 14000);
    return {
      node: m,
      set(t) {
        if (text.textContent === t) return;
        text.textContent = t;
        text.classList.remove("swap"); void text.offsetWidth; text.classList.add("swap");
      },
      stop() { clearTimeout(timer); },
    };
  }

  function sourceTags(sources) {
    if (!sources) return null;
    const items = [...(sources.services || []), ...(sources.links || [])];
    if (!items.length) return null;
    const wrap = el("div", "sources");
    wrap.appendChild(el("span", "label", "Sources"));
    for (const s of items) {
      const a = el("a", "tag");
      a.href = s.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.title = s.url;
      a.innerHTML = "<span>" + esc(s.label) + '</span><i class="ph ph-arrow-up-right" aria-hidden="true"></i>';
      wrap.appendChild(a);
    }
    return wrap;
  }

  function showAnswer(holder, text, sources) {
    holder.stop();
    const m = holder.node;
    m.removeAttribute("aria-busy");
    m.innerHTML = "";
    const body = el("div", "body", markdown(text));
    m.appendChild(body);
    const tags = sourceTags(sources);
    if (tags) m.appendChild(tags);
    toBottom();
  }

  function showError(holder, message, detail, retryText) {
    holder.stop();
    const m = holder.node;
    m.removeAttribute("aria-busy");
    m.className = "msg";
    m.innerHTML = "";
    const box = el("div", "error");
    box.setAttribute("role", "alert");
    box.appendChild(el("p", "title", esc(message)));
    if (detail) box.appendChild(el("details", "", "<summary>Technical details</summary><pre>" + esc(detail) + "</pre>"));
    if (retryText) {
      const b = el("button", "ghost retry", "<span>Try again</span>");
      b.type = "button";
      b.addEventListener("click", () => { m.remove(); send(retryText, true); });
      box.appendChild(b);
    }
    m.appendChild(box);
    toBottom();
  }

  /* ---------- talking to the server ---------- */
  async function send(text, isRetry) {
    if (busy || !text.trim()) return;
    busy = true;
    updateSend();
    $("#empty")?.remove();
    if (!isRetry) addUser(text);
    const holder = addThinking();
    controller = new AbortController();
    let finished = false;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, message: text }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        let info = {};
        try { info = await res.json(); } catch (_) {}
        showError(holder, info.message || "The assistant could not answer right now (error " + res.status + ").", info.detail, text);
        finished = true;
        if (res.status === 503) loadStatus();
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const handle = (line) => {
        if (!line.trim()) return;
        let ev;
        try { ev = JSON.parse(line); } catch (_) { return; }
        if (ev.type === "status") holder.set(ev.text);
        else if (ev.type === "final") { showAnswer(holder, ev.text, ev.sources); finished = true; }
        else if (ev.type === "error") { showError(holder, ev.message, ev.detail, text); finished = true; }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop();
        parts.forEach(handle);
      }
      handle(buf);
      if (!finished) showError(holder, "The connection ended before an answer arrived. Please try again.", null, text);
    } catch (e) {
      if (e.name === "AbortError") { holder.node.remove(); return; }
      showError(holder, "Could not reach the assistant. Make sure the server is running (python3 scripts/server.py) and try again.", String(e), text);
      loadStatus();
    } finally {
      holder.stop();
      busy = false;
      controller = null;
      updateSend();
      if (matchMedia("(pointer: fine)").matches) input.focus();
    }
  }

  async function loadStatus() {
    try {
      const r = await fetch("/api/status", { cache: "no-store" });
      const s = await r.json();
      if (s.ok) {
        notice.hidden = true;
        if (s.services && s.services.exa === false) {
          notice.textContent = "Web search is offline, so prices and very new releases may be unavailable.";
          notice.hidden = false;
        }
      } else {
        notice.textContent = (s.problem && s.problem.message) || "The assistant is not ready yet.";
        notice.hidden = false;
      }
    } catch (_) {
      notice.textContent = "The server is not running. Start it with python3 scripts/server.py, then reload this page.";
      notice.hidden = false;
    }
  }

  /* ---------- composer ---------- */
  function updateSend() {
    sendBtn.disabled = busy || !input.value.trim();
  }
  function grow() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 11 * 16) + "px";
  }
  input.addEventListener("input", () => { grow(); updateSend(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = ""; grow(); updateSend();
    send(text);
  });
  document.querySelectorAll(".starters button").forEach((b) =>
    b.addEventListener("click", () => send(b.dataset.q)));

  $("#new-chat").addEventListener("click", () => {
    if (controller) controller.abort();
    fetch("/api/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: sessionId }) }).catch(() => {});
    sessionId = newId();
    location.reload();
  });

  updateSend();
  loadStatus();
})();
