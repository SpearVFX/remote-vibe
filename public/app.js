'use strict';

const $ = (sel) => document.querySelector(sel);
const store = {
  get(k, d = null) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const KEYS = {
  esc: '\x1b', tab: '\t', stab: '\x1b[Z', enter: '\r', ctrlc: '\x03',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
};

let token = store.get('rv-token');

// ---------- pairing ----------

function takeTokenFromHash() {
  const m = location.hash.match(/token=([\w-]+)/);
  if (!m) return;
  token = m[1];
  store.set('rv-token', token);
  history.replaceState(null, '', location.pathname);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    showPair('Token rejected. Re-pair this device.');
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.status === 204 ? null : res.json();
}

function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
}

function showPair(error) {
  showScreen('pair');
  $('#pair-error').hidden = !error;
  $('#pair-error').textContent = error || '';
}

$('#pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  token = $('#pair-token').value.trim().replace(/^.*token=/, '');
  store.set('rv-token', token);
  try {
    await api('/api/ping');
    showList();
  } catch {}
});

$('#unpair').addEventListener('click', () => {
  if (!confirm('Forget the token on this device?')) return;
  store.del('rv-token');
  token = null;
  showPair();
});

// ---------- session list ----------

async function showList() {
  detachTerminal();
  showScreen('list');
  await refreshSessions();
}

function el(tag, props = {}, ...children) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...children);
  return n;
}

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

async function refreshSessions() {
  let sessions;
  try { sessions = await api('/api/sessions'); } catch { return; }
  const ul = $('#sessions');
  ul.replaceChildren();
  $('#empty').hidden = sessions.length > 0;
  for (const s of sessions) {
    const kill = el('button', { className: 'kill', textContent: '✕', ariaLabel: 'Kill session' });
    kill.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Kill "${s.name}"?`)) return;
      await api(`/api/sessions/${s.id}`, { method: 'DELETE' }).catch(() => {});
      refreshSessions();
    });
    const li = el('li', { className: `session kind-${s.kind}` },
      el('div', { className: 'info' },
        el('div', { className: 'name', textContent: s.name }),
        el('div', { className: 'cwd', textContent: s.cwd + '\u200e' })),
      el('span', {
        className: `badge ${s.exited ? '' : 'live'}`,
        textContent: s.exited ? `exited ${s.exitCode}` : ago(s.lastActivity),
      }),
      kill);
    li.addEventListener('click', () => openTerminal(s));
    ul.append(li);
  }
}

$('#refresh').addEventListener('click', refreshSessions);

// ---------- project picker ----------

let pickerKind = 'agent';
let projectsCache = null;

async function openPicker(kind) {
  pickerKind = kind;
  $('#picker-title').textContent = kind === 'agent' ? 'Start agent in…' : 'Open shell in…';
  $('#picker-filter').value = '';
  $('#picker').showModal();
  try { projectsCache = await api('/api/projects'); } catch { return; }
  renderProjects();
}

function renderProjects() {
  const q = $('#picker-filter').value.trim().toLowerCase();
  const ul = $('#projects');
  ul.replaceChildren();
  const items = projectsCache.projects.filter((p) => p.name.toLowerCase().includes(q));
  // Typing an absolute or ~ path offers it directly.
  if (q.startsWith('/') || q.startsWith('~')) items.unshift({ name: q, path: q });
  for (const p of items) {
    const b = el('button', { type: 'button', textContent: p.name });
    b.addEventListener('click', () => createSession(pickerKind, p.path));
    ul.append(el('li', {}, b));
  }
}

async function createSession(kind, cwd) {
  $('#picker').close();
  try {
    const s = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ kind, cwd }) });
    openTerminal(s);
  } catch (err) {
    alert(`Could not start session: ${err.message}`);
  }
}

$('#picker-filter').addEventListener('input', renderProjects);
$('#picker-root').addEventListener('click', (e) => {
  e.preventDefault();
  createSession(pickerKind, projectsCache?.root);
});
$('#new-agent').addEventListener('click', () => openPicker('agent'));
$('#new-shell').addEventListener('click', () => openPicker('shell'));

// ---------- terminal ----------

let term = null;
let fit = null;
let ws = null;
let current = null;
let retry = 0;
let retryTimer = null;
let wakeLock = null;
const mods = { ctrl: false, alt: false };

function ensureTerm() {
  if (term) return;
  term = new Terminal({
    fontFamily: 'ui-monospace, "JetBrains Mono", "Fira Code", Menlo, monospace',
    fontSize: Number(store.get('rv-font', '13')),
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: { background: '#000000' },
  });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.open($('#terminal'));
  term.onData((data) => sendInput(applyMods(data)));
  term.onResize(({ cols, rows }) => sendControl({ type: 'resize', cols, rows }));
  new ResizeObserver(() => fitSoon()).observe($('#terminal'));
}

let fitPending = false;
function fitSoon() {
  if (fitPending) return;
  fitPending = true;
  requestAnimationFrame(() => {
    fitPending = false;
    if (term && !$('#term-screen').hidden) fit.fit();
  });
}

function applyMods(data) {
  if (!mods.ctrl && !mods.alt) return data;
  let out = data;
  if (mods.ctrl && data.length === 1) {
    const c = data.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) out = String.fromCharCode(c & 0x1f);
    else if (data === ' ') out = '\x00';
  }
  if (mods.alt) out = '\x1b' + out;
  setMod('ctrl', false);
  setMod('alt', false);
  return out;
}

function setMod(name, on) {
  mods[name] = on;
  document.querySelector(`[data-mod="${name}"]`).classList.toggle('on', on);
}

function sendInput(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
}

function sendControl(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send('\x00' + JSON.stringify(msg));
}

function setStatus(state) {
  $('#status').className = `status ${state}`;
}

function openTerminal(s) {
  current = s;
  showScreen('term-screen');
  if (history.state?.term !== s.id) history.pushState({ term: s.id }, '');
  $('#term-title').textContent = s.name;
  ensureTerm();
  term.reset();
  fit.fit();
  connect();
  term.focus();
  acquireWakeLock();
}

function connect() {
  clearTimeout(retryTimer);
  if (!current) return;
  if (ws) { ws.onclose = null; ws.close(); }
  setStatus('connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws/${current.id}`, ['remote-vibe', `token.${token}`]);
  ws = sock;
  let gotData = false;
  sock.onopen = () => {
    retry = 0;
    setStatus('ok');
    sendControl({ type: 'resize', cols: term.cols, rows: term.rows });
  };
  sock.onmessage = (ev) => {
    const data = ev.data;
    if (data.startsWith('{"type":"exit"')) return;
    if (!gotData) { term.reset(); gotData = true; } // replay buffer redraws the screen
    term.write(data);
  };
  sock.onclose = (ev) => {
    if (ws !== sock) return;
    setStatus('down');
    if (ev.code === 4000) { term.write('\r\n\x1b[2m[session killed]\x1b[0m\r\n'); return; }
    if (!current) return;
    // Unknown session (e.g. server restarted) → back to list.
    if (retry > 2) {
      api('/api/sessions').then((list) => {
        if (!list.some((x) => x.id === current?.id)) { alert('Session no longer exists.'); history.back(); }
      }).catch(() => {});
    }
    retryTimer = setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
  };
}

function detachTerminal() {
  current = null;
  clearTimeout(retryTimer);
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  releaseWakeLock();
}

async function acquireWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !current) return;
  acquireWakeLock();
  if (!ws || ws.readyState > WebSocket.OPEN) { retry = 0; connect(); }
});

window.addEventListener('popstate', () => {
  if (!history.state?.term) showList();
});
$('#back').addEventListener('click', () => history.back());

// Key bar: use pointerdown + preventDefault so the soft keyboard stays open.
$('#keys').addEventListener('pointerdown', (e) => {
  const b = e.target.closest('button');
  if (!b || b.id === 'compose-toggle') return;
  e.preventDefault();
  if (b.dataset.mod) return setMod(b.dataset.mod, !mods[b.dataset.mod]);
  if (b.dataset.send) return sendInput(applyMods(b.dataset.send));
  if (b.dataset.key === 'paste') return pasteClipboard();
  if (b.dataset.key) sendInput(KEYS[b.dataset.key]);
});

async function pasteClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) term.paste(text);
  } catch {
    openCompose();
  }
}

function setFont(delta) {
  const size = Math.max(8, Math.min(28, term.options.fontSize + delta));
  term.options.fontSize = size;
  store.set('rv-font', String(size));
  fit.fit();
}
$('#font-up').addEventListener('click', () => setFont(1));
$('#font-down').addEventListener('click', () => setFont(-1));

// ---------- compose box ----------

function openCompose() {
  $('#compose').hidden = false;
  $('#compose-toggle').classList.add('on');
  $('#compose-text').focus();
  fitSoon();
}
function closeCompose() {
  $('#compose').hidden = true;
  $('#compose-toggle').classList.remove('on');
  fitSoon();
  term.focus();
}

function submitCompose(withEnter) {
  const text = $('#compose-text').value;
  if (!text) return;
  // Bracketed paste keeps multi-line prompts as one message in TUI agents and shells.
  term.paste(text);
  if (withEnter) setTimeout(() => sendInput('\r'), 80);
  $('#compose-text').value = '';
  closeCompose();
}

$('#compose-toggle').addEventListener('click', () => ($('#compose').hidden ? openCompose() : closeCompose()));
$('#compose-cancel').addEventListener('click', closeCompose);
$('#compose-send').addEventListener('click', () => submitCompose(true));
$('#compose-paste-only').addEventListener('click', () => submitCompose(false));
$('#compose-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitCompose(true); }
});

// ---------- viewport / keyboard handling ----------

function updateVh() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--vh', `${h}px`);
  fitSoon();
}
window.visualViewport?.addEventListener('resize', updateVh);
window.addEventListener('resize', updateVh);
updateVh();

// ---------- boot ----------

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

takeTokenFromHash();
history.replaceState(null, '', location.pathname);
if (!token) showPair();
else api('/api/ping').then(showList).catch(() => {});
