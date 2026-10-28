const TOKEN_KEY = "omp-mobile.token";
const $ = (selector) => document.querySelector(selector);

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  data: null,
  loading: false,
  poll: null,
  chatSession: null,
  term: null,
  fit: null,
  ws: null,
  termSession: null,
  installEvent: null,
};

class AuthError extends Error {}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function toast(message, isError = false) {
  const element = $("#toast");
  element.textContent = String(message);
  element.classList.toggle("error", isError);
  element.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add("hidden"), 4500);
}

function setOnline(value) {
  const dot = $("#connection-dot");
  dot.classList.toggle("online", value === true);
  dot.classList.toggle("offline", value === false);
}

function setAuthVisible(visible) {
  $("#auth-view").classList.toggle("hidden", !visible);
  $("#main-view").classList.toggle("hidden", visible);
  if (visible) {
    setOnline(false);
    $("#host-label").textContent = "not connected";
  }
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set("authorization", `Bearer ${state.token}`);
  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, { ...options, headers, cache: "no-store" });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text };
  }
  if (response.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    state.token = "";
    setAuthVisible(true);
    throw new AuthError("API token 无效或已过期");
  }
  if (!response.ok) {
    throw new Error(body?.error || `HTTP ${response.status}`);
  }
  return body;
}

async function loadState({ quiet = false, force = false } = {}) {
  if (!state.token) {
    setAuthVisible(true);
    return;
  }
  if (state.loading) return;
  state.loading = true;
  try {
    const data = await api(`/api/state${force ? "?refresh=1" : ""}`);
    state.data = data;
    setAuthVisible(false);
    setOnline(true);
    render();
  } catch (error) {
    if (error instanceof AuthError) return;
    setOnline(false);
    if (!quiet) toast(error.message, true);
  } finally {
    state.loading = false;
  }
}

function render() {
  const data = state.data;
  if (!data) return;
  $("#host-label").textContent = data.name || location.host;
  $("#hero-host").textContent = data.name || location.host;
  $("#meta-adapter").textContent = `${data.adapter} · ${data.platform}`;
  $("#meta-omp").textContent = data.health?.omp || "unknown";
  $("#meta-roots").textContent = (data.roots || []).join(", ") || "—";
  $("#meta-roots").title = (data.roots || []).join("\n");

  const health = data.health || {};
  const badge = $("#health-badge");
  badge.textContent = health.ok ? "online" : "degraded";
  badge.classList.toggle("ok", Boolean(health.ok));
  badge.classList.toggle("bad", !health.ok);
  badge.title = health.ok ? "tmux and omp are available" : health.error || health.omp || health.tmux || "unavailable";

  const roots = data.roots || [];
  const datalist = $("#roots-list");
  datalist.replaceChildren(...roots.map((root) => {
    const option = document.createElement("option");
    option.value = root;
    return option;
  }));
  const cwdInput = $("#cwd-input");
  if (!cwdInput.value && roots[0]) cwdInput.value = roots[0];

  const sessions = data.sessions || [];
  $("#session-count").textContent = String(sessions.length);
  $("#empty-state").classList.toggle("hidden", sessions.length > 0);
  $("#sessions").innerHTML = sessions.map(renderSession).join("");
}

function renderSession(session) {
  const host = session.host;
  const chips = [];
  if (host) {
    if (host.busy === true) chips.push(["working", "warn"]);
    else if (host.busy === false) chips.push(["idle", "ok"]);
    else chips.push(["unknown", ""]);
    if (host.inputRequired) chips.push(["needs input", "warn"]);
    chips.push([host.relayConnected ? "relay" : "relay off", host.relayConnected ? "ok" : "bad"]);
    chips.push([host.access, ""]);
    if (host.model) chips.push([`${host.model.provider}/${host.model.id}`, ""]);
  } else {
    chips.push(["no collab host", "bad"]);
  }
  const active = state.chatSession === session.name ? " active" : "";
  const chatDisabled = host ? "" : " disabled";
  const terminalDisabled = state.data?.terminal ? "" : " disabled";
  return `
    <article class="session-card${active}" data-session="${escapeHtml(session.name)}">
      <div class="session-head">
        <div>
          <h3 class="session-name">${escapeHtml(session.name)}</h3>
          <p class="session-cwd">${escapeHtml(session.cwd)}</p>
        </div>
      </div>
      <div class="chips">
        ${chips.map(([label, tone]) => `<span class="chip ${tone}">${escapeHtml(label)}</span>`).join("")}
      </div>
      <div class="session-actions">
        <button type="button" class="primary" data-action="chat"${chatDisabled}>聊天</button>
        <button type="button" data-action="terminal"${terminalDisabled}>终端</button>
        <button type="button" data-action="output">输出</button>
        <button type="button" class="danger" data-action="stop">停止</button>
      </div>
    </article>`;
}

async function startSession(event) {
  event.preventDefault();
  const cwd = $("#cwd-input").value.trim();
  if (!cwd) return toast("请输入工作目录", true);
  const button = $("#start-button");
  button.disabled = true;
  button.textContent = "启动中…";
  try {
    const body = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ cwd }),
    });
    toast("omp 已启动");
    await loadState({ quiet: true, force: true });
    if (body?.session?.name) await openChat(body.session.name);
  } catch (error) {
    if (!(error instanceof AuthError)) toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "启动会话";
  }
}

async function stopSession(name) {
  if (!confirm(`停止 ${name}？`)) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (state.chatSession === name) closeChat();
    if (state.termSession === name) closeTerminal();
    toast("会话已停止");
    await loadState({ quiet: true, force: true });
  } catch (error) {
    if (!(error instanceof AuthError)) toast(error.message, true);
  }
}

function validChatUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") return url.toString();
    if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      return url.toString();
    }
  } catch {
    // Fall through.
  }
  return null;
}

async function openChat(name) {
  const overlay = $("#chat-overlay");
  const frame = $("#chat-frame");
  const hint = $("#chat-hint");
  const loading = $("#chat-loading");
  $("#chat-session-label").textContent = name;
  hint.textContent = "正在获取 Collab 链接…";
  loading.classList.remove("hidden");
  overlay.classList.remove("hidden");
  try {
    const link = await api(`/api/sessions/${encodeURIComponent(name)}/link`);
    const url = validChatUrl(link.url);
    if (!url) throw new Error("bridge 返回了无效的聊天链接");
    state.chatSession = name;
    $("#chat-external").href = url;
    frame.src = url;
    hint.textContent = "如果聊天区域空白，点右上角 ↗ 在浏览器打开。";
    frame.onload = () => {
      loading.classList.add("hidden");
      if (state.chatSession === name) hint.textContent = "如果聊天区域空白，点右上角 ↗ 在浏览器打开。";
    };
    setTimeout(() => loading.classList.add("hidden"), 8000);
    render();
  } catch (error) {
    overlay.classList.add("hidden");
    state.chatSession = null;
    if (!(error instanceof AuthError)) toast(error.message, true);
  }
}

function closeChat() {
  $("#chat-frame").src = "about:blank";
  $("#chat-loading").classList.add("hidden");
  $("#chat-overlay").classList.add("hidden");
  state.chatSession = null;
  render();
}

function ensureTerminal() {
  if (state.term) return state.term;
  const TerminalCtor = window.Terminal?.Terminal || window.Terminal;
  const FitCtor = window.FitAddon?.FitAddon || window.FitAddon;
  if (!TerminalCtor || !FitCtor) throw new Error("xterm 资源加载失败");
  const term = new TerminalCtor({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    theme: {
      background: "#000000",
      foreground: "#d8e2f2",
      cursor: "#7c9cff",
      selectionBackground: "#33405a",
    },
    scrollback: 5000,
    convertEol: false,
  });
  const fit = new FitCtor();
  term.loadAddon(fit);
  term.open($("#terminal"));
  term.onData((data) => {
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: "input", data }));
    }
  });
  term.onResize(({ cols, rows }) => {
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  });
  state.term = term;
  state.fit = fit;
  return term;
}

function sendTerminalResize() {
  if (!state.fit || !state.term) return;
  try {
    state.fit.fit();
  } catch {
    // The overlay can be hidden or zero-sized.
  }
}

async function openTerminal(name = null) {
  const overlay = $("#term-overlay");
  const label = $("#term-session-label");
  label.textContent = name || "shell";
  try {
    const ticket = await api("/api/terminal/ticket", {
      method: "POST",
      body: JSON.stringify({
        session: name || undefined,
        cwd: name ? undefined : state.data?.roots?.[0],
        cols: 80,
        rows: 24,
      }),
    });
    overlay.classList.remove("hidden");
    const term = ensureTerminal();
    term.reset();
    state.termSession = name;
    requestAnimationFrame(() => {
      sendTerminalResize();
      term.focus();
    });
    if (state.ws) {
      try { state.ws.close(); } catch { /* ignore */ }
    }
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${location.host}/ws/terminal?ticket=${encodeURIComponent(ticket.ticket)}`);
    ws.binaryType = "arraybuffer";
    state.ws = ws;
    const decoder = new TextDecoder();
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === "exit") {
          term.write(`\r\n[process exited${message.exitCode !== undefined ? `: ${message.exitCode}` : ""}]\r\n`);
        } else if (message.type === "error") {
          term.write(`\r\n[${message.message}]\r\n`);
          toast(message.message, true);
        }
      } else {
        term.write(decoder.decode(new Uint8Array(event.data)));
      }
    };
    ws.onopen = () => {
      overlay.dataset.status = "connected";
      sendTerminalResize();
      term.focus();
    };
    ws.onclose = () => {
      overlay.dataset.status = "closed";
      if (state.ws === ws) state.ws = null;
    };
    ws.onerror = () => toast("终端连接失败", true);
  } catch (error) {
    overlay.classList.add("hidden");
    if (!(error instanceof AuthError)) toast(error.message, true);
  }
}

function closeTerminal() {
  if (state.ws) {
    try { state.ws.close(); } catch { /* ignore */ }
    state.ws = null;
  }
  $("#term-overlay").classList.add("hidden");
  state.termSession = null;
}

async function openOutput(name) {
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(name)}/output?lines=100`);
    $("#output-session-label").textContent = name;
    $("#output-pre").textContent = data.output || "(no output)";
    $("#output-overlay").classList.remove("hidden");
  } catch (error) {
    if (!(error instanceof AuthError)) toast(error.message, true);
  }
}

function openSettings() {
  $("#settings-token").value = state.token;
  $("#settings-overlay").classList.remove("hidden");
}

function closeSettings() {
  $("#settings-overlay").classList.add("hidden");
}

function closeTopOverlay() {
  for (const id of ["settings-overlay", "output-overlay", "term-overlay", "chat-overlay"]) {
    const element = document.getElementById(id);
    if (!element.classList.contains("hidden")) {
      if (id === "chat-overlay") closeChat();
      else if (id === "term-overlay") closeTerminal();
      else element.classList.add("hidden");
      return true;
    }
  }
  return false;
}

function saveToken(token) {
  const value = String(token || "").trim();
  if (!value) {
    toast("token 不能为空", true);
    return;
  }
  localStorage.setItem(TOKEN_KEY, value);
  state.token = value;
  setAuthVisible(false);
  loadState({ force: true }).catch((error) => toast(error.message, true));
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  state.token = "";
  state.data = null;
  closeChat();
  closeTerminal();
  closeSettings();
  setAuthVisible(true);
}

function wireEvents() {
  $("#auth-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveToken($("#token-input").value);
  });
  $("#refresh-button").addEventListener("click", () => loadState({ force: true }));
  $("#settings-button").addEventListener("click", openSettings);
  $("#settings-close").addEventListener("click", closeSettings);
  $("#settings-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveToken($("#settings-token").value);
    closeSettings();
  });
  $("#logout-button").addEventListener("click", logout);
  $("#start-form").addEventListener("submit", startSession);
  $("#shell-button").addEventListener("click", () => void openTerminal(null));

  $("#sessions").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    const card = button?.closest("[data-session]");
    if (!button || !card) return;
    const name = card.dataset.session;
    if (!name) return;
    switch (button.dataset.action) {
      case "chat": void openChat(name); break;
      case "terminal": void openTerminal(name); break;
      case "output": void openOutput(name); break;
      case "stop": void stopSession(name); break;
    }
  });

  $("#chat-close").addEventListener("click", closeChat);
  $("#term-close").addEventListener("click", closeTerminal);
  $("#output-close").addEventListener("click", () => $("#output-overlay").classList.add("hidden"));
  $("#chat-external").addEventListener("click", () => {
    if (state.chatSession) render();
  });

  $(".keybar").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-key]");
    if (!button || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    const sequences = {
      escape: "\x1b",
      tab: "\t",
      "ctrl-c": "\x03",
      up: "\x1b[A",
      down: "\x1b[B",
      left: "\x1b[D",
      right: "\x1b[C",
      enter: "\r",
    };
    const data = sequences[button.dataset.key];
    if (data) state.ws.send(JSON.stringify({ type: "input", data }));
    state.term?.focus();
  });

  window.addEventListener("resize", sendTerminalResize);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) loadState({ quiet: true });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && closeTopOverlay()) event.preventDefault();
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installEvent = event;
    $("#install-button").classList.remove("hidden");
  });
  $("#install-button").addEventListener("click", async () => {
    if (!state.installEvent) return;
    state.installEvent.prompt();
    await state.installEvent.userChoice.catch(() => null);
    state.installEvent = null;
    $("#install-button").classList.add("hidden");
  });
  window.addEventListener("appinstalled", () => {
    $("#install-button").classList.add("hidden");
  });
}

function startPolling() {
  clearInterval(state.poll);
  state.poll = setInterval(() => {
    if (!document.hidden) loadState({ quiet: true });
  }, 3000);
}

async function init() {
  wireEvents();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  if (state.token) {
    setAuthVisible(false);
    await loadState({ quiet: true });
  } else {
    setAuthVisible(true);
  }
  startPolling();
}

void init();
