// webtmux client: one terminal attached to a tmux web session, plus a windows overview
const $ = (id) => document.getElementById(id);
const touch = matchMedia('(pointer: coarse)').matches;
const mono = getComputedStyle(document.documentElement).getPropertyValue('--mono');

// wait for the webfont so xterm measures cells with it, not a fallback
await Promise.all(['', 'bold ', 'italic ', 'italic bold '].map((s) => document.fonts.load(`${s}14px "JetBrains Mono"`))).catch(() => {});

const term = new Terminal({
  fontFamily: mono,
  fontSize: touch ? 12 : 14,
  lineHeight: 1.1,
  cursorBlink: true,
  allowProposedApi: true, // needed by the unicode11 addon
  rescaleOverlappingGlyphs: true, // squeeze fallback-font symbols that are too wide for their cells
  // github dark palette, on our background
  theme: {
    background: '#0d0f12', foreground: '#d6dbe1', cursor: '#6cb6ff', cursorAccent: '#0d0f12', selectionBackground: '#6cb6ff55',
    black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
    blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
    brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
    brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#ffffff',
  },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
// unicode 11 widths, closer to what tmux and claude code assume for symbols and emoji
term.loadAddon(new Unicode11Addon.Unicode11Addon());
term.unicode.activeVersion = '11';
term.open($('term'));

// loads the webgl renderer (sharper text, gapless box drawing); xterm falls back to the dom renderer without it
let webglLosses = 0;
function loadWebgl() {
  try {
    const webgl = new WebglAddon.WebglAddon();
    // context lost (gpu reset, phone backgrounding the tab): use the dom renderer until the page is visible again
    webgl.onContextLoss(() => {
      webgl.dispose();
      if (++webglLosses > 5) return; // keeps failing, stay on dom
      if (document.visibilityState === 'visible') setTimeout(loadWebgl, 1000);
      else document.addEventListener('visibilitychange', loadWebgl, { once: true });
    });
    term.loadAddon(webgl);
  } catch (e) {
    console.warn('webgl unavailable', e);
  }
}
loadWebgl();

let ws = null;
let retry = 0;
let currentWin = null; // window id to restore on reconnect
let windows = [];
let ctrl = false;
let poll = null;
let lastMsg = 0; // time of last server message, for liveness
let held = null; // keys typed while a window switch is in flight
let refocus = false; // overview keeps focus on the current window's card until the user moves focus
let autoFocus = false; // set while we move focus ourselves, so it doesn't count as the user's
let previewCard = null; // overview card whose window fills the preview pane: the last focused one

// sends a json control message to the server
function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// opens the websocket, reconnecting with backoff when it drops
function connect() {
  const q = new URLSearchParams({ cols: term.cols, rows: term.rows });
  if (currentWin) q.set('win', currentWin);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?${q}`);
  ws.binaryType = 'arraybuffer';
  lastMsg = Date.now();
  const attempt = ws;
  setTimeout(() => attempt.readyState === WebSocket.CONNECTING && attempt.close(), 10000); // hung connect -> onclose retries
  ws.onopen = () => {
    $('status').textContent = '';
    held = null;
    term.reset(); // tmux redraws the full screen on attach
    send({ t: 'resize', cols: term.cols, rows: term.rows }); // in case it changed while connecting
    if (!$('overview').hidden) send({ t: 'list', previews: true });
  };
  ws.onmessage = (e) => {
    lastMsg = Date.now();
    if (typeof e.data !== 'string') return term.write(new Uint8Array(e.data));
    const msg = JSON.parse(e.data);
    if (msg.t === 'windows') onWindows(msg.windows, msg.previews, msg.switched);
    if (msg.t === 'error') showError(msg.msg);
  };
  ws.onclose = () => {
    $('status').textContent = 'reconnecting…';
    setTimeout(connect, Math.min(500 * 2 ** retry++, 8000));
  };
}

// heartbeat: refreshes the title and replaces a silently dead connection (network change, sleep)
setInterval(() => {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (Date.now() - lastMsg > 20000) {
    ws.onclose = ws.onmessage = null; // ignore the old socket entirely
    ws.close();
    connect();
    return;
  }
  send({ t: 'list', previews: false });
}, 5000);

// shows a failed window action and brings the overview back instead of typing into the wrong window
function showError(text) {
  held = null; // drop keys meant for the window we couldn't switch to
  $('overview-msg').textContent = text;
  setTimeout(() => $('overview-msg').textContent === text && ($('overview-msg').textContent = ''), 4000);
  if ($('overview').hidden) openOverview();
}

// updates state from a window list and re-renders what's visible
function onWindows(list, previews, switched) {
  retry = 0; // setup succeeded, so reset reconnect backoff
  if (switched && held) {
    for (const d of held) send({ t: 'in', d });
    held = null;
  }
  windows = list;
  const active = windows.find((w) => w.active);
  if (active) {
    currentWin = active.id;
    $('title').textContent = `${active.index}: ${active.name}`;
  }
  if (previews && !$('overview').hidden) renderGrid();
}

// sends terminal input, applying the sticky on-screen ctrl modifier
function input(d) {
  if (ctrl) {
    const c = d.toUpperCase().charCodeAt(0);
    if (d.length === 1 && c >= 64 && c < 96) d = String.fromCharCode(c - 64);
    else if (/^\x1b\[[A-D]$/.test(d)) d = `\x1b[1;5${d[2]}`; // ctrl+arrow
    setCtrl(false);
  }
  if (held) held.push(d);
  else send({ t: 'in', d });
}

// asks the server to select or create a window, holding typed keys until it confirms
function switchWindow(msg) {
  held = [];
  send(msg);
  closeOverview();
}
term.onData(input);
term.onResize(({ cols, rows }) => send({ t: 'resize', cols, rows }));

// wheel and touch swipes scroll tmux history; accumulated and sent in batches
let scrollLines = 0;
term.attachCustomWheelEventHandler((e) => {
  scrollLines += e.deltaMode === 1 ? e.deltaY : e.deltaY / 33;
  return false; // tmux handles it, not xterm
});
let touchY = null;
$('term').addEventListener('touchstart', (e) => (touchY = e.touches[0].clientY), { passive: true });
$('term').addEventListener('touchmove', (e) => {
  const y = e.touches[0].clientY;
  scrollLines += (touchY - y) / ($('term').clientHeight / term.rows); // finger down = scroll back
  touchY = y;
}, { passive: true });
setInterval(() => {
  const lines = Math.trunc(scrollLines);
  if (!lines) return;
  scrollLines -= lines;
  send({ t: 'scroll', lines });
}, 50);
new ResizeObserver(() => fit.fit()).observe($('term'));

// keep the layout inside the visual viewport (phone keyboard)
function fitViewport() {
  const vv = window.visualViewport;
  document.body.style.height = `${vv ? vv.height : window.innerHeight}px`;
  window.scrollTo(0, 0);
}
window.visualViewport?.addEventListener('resize', fitViewport);
window.visualViewport?.addEventListener('scroll', fitViewport);
fitViewport();

// on-screen keys for phones
function setCtrl(on) {
  ctrl = on;
  $('ctrl').classList.toggle('on', on);
}
for (const btn of $('keys').querySelectorAll('button')) {
  const press = () => (btn.id === 'ctrl' ? setCtrl(!ctrl) : input(btn.dataset.key));
  btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep terminal focus
  btn.addEventListener('touchstart', (e) => { e.preventDefault(); press(); }, { passive: false });
  btn.addEventListener('click', press);
}

// windows overview
function openOverview() {
  $('overview').hidden = false;
  document.activeElement?.blur(); // terminal or the button that opened us
  refocus = true; // currentWin may be stale until the server answers
  focusCurrentCard();
  send({ t: 'list', previews: true });
  poll = setInterval(() => send({ t: 'list', previews: true }), 1500);
}

// focuses the current window's card so arrow keys have a starting point
function focusCurrentCard() {
  autoFocus = true;
  $('grid').querySelector(`.card[data-id="${currentWin}"]`)?.focus();
  autoFocus = false;
}

// moves focus to the previous/next overview card, wrapping around
function moveFocus(step) {
  const cards = [...$('grid').children];
  const i = cards.indexOf(document.activeElement?.closest('.card'));
  if (i < 0) return focusCurrentCard();
  cards[(i + step + cards.length) % cards.length].focus();
}

function closeOverview() {
  $('overview').hidden = true;
  clearInterval(poll);
  term.focus();
}

// creates an element with optional class and text
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// builds an empty overview card; handlers read card.win, which renderGrid keeps current
function makeCard(id) {
  const card = el('div', 'card');
  card.dataset.id = id;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  // asks for confirmation (enter accepts), then closes this card's window
  const closeWin = () => {
    const w = card.win;
    if (confirm(`Close window ${w.index}: ${w.name}?`)) send({ t: 'kill', id: w.id });
  };
  const kill = el('button', 'icon kill', '✕');
  kill.title = 'Close window (x)';
  kill.onclick = (e) => {
    e.stopPropagation();
    closeWin();
  };
  const head = el('div', 'card-head');
  head.append(el('span', 'card-name'), kill);
  card.append(head, el('pre'));
  const select = () => switchWindow({ t: 'select', id: card.win.id });
  card.onclick = select;
  card.onkeydown = (e) => {
    if (e.target !== card) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select();
    } else if (e.key.toLowerCase() === 'x' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
      e.preventDefault();
      closeWin();
    }
  };
  return card;
}

const addCard = el('button', 'card new', '+ New window');
addCard.onclick = () => switchWindow({ t: 'new' });

// renders the overview grid, updating cards in place so a refresh can't swallow a tap
function renderGrid() {
  const grid = $('grid');
  const old = new Map([...grid.querySelectorAll('.card[data-id]')].map((c) => [c.dataset.id, c]));
  const next = windows.map((w) => {
    const card = old.get(w.id) || makeCard(w.id);
    card.win = w;
    card.classList.toggle('active', w.active);
    card.querySelector('.card-name').textContent = `${w.index}: ${w.name}`;
    card.querySelector('pre').textContent = w.preview || '';
    return card;
  });
  next.push(addCard);
  const focused = document.activeElement; // a reshuffle drops focus, so restore it after
  // only reshuffle the dom when the set or order of windows changed
  if (next.length !== grid.children.length || next.some((c, i) => grid.children[i] !== c)) grid.replaceChildren(...next);
  // show the bottom of each screen, where the prompt usually is
  for (const pre of grid.querySelectorAll('pre')) pre.scrollTop = pre.scrollHeight;
  if (!refocus && focused !== document.body && focused?.isConnected) focused.focus();
  else focusCurrentCard(); // user hasn't picked yet, nothing focused, or the focused window is gone
  renderPreview();
}

// width of one monospace character per px of font size
const charWidth = (() => {
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = `100px ${mono}`;
  return ctx.measureText('M').width / 100;
})();

// shows the focused card's window in the preview pane, scaled so its whole screen fits
function renderPreview() {
  const w = previewCard?.isConnected ? previewCard.win : null; // the new-window card has no window
  const pre = $('preview').querySelector('pre');
  pre.textContent = w?.preview || '';
  if (!w) return;
  const pad = 16; // matches the preview padding on both sides
  const size = Math.min(14, ($('preview').clientWidth - pad) / (w.cols * charWidth), ($('preview').clientHeight - pad) / (w.rows * 1.2));
  pre.style.fontSize = `${Math.max(size, 1)}px`;
  $('preview').scrollTop = $('preview').scrollHeight; // if it still overflows, show the bottom where the prompt is
}
new ResizeObserver(renderPreview).observe($('preview'));

$('windows-btn').onclick = openOverview;
$('title').onclick = openOverview;
$('close-overview').onclick = closeOverview;
$('overview').addEventListener('focusin', () => autoFocus || (refocus = false)); // the user moved focus, keep their pick
$('grid').addEventListener('focusin', (e) => {
  previewCard = e.target.closest('.card');
  renderPreview();
});
// overview shortcuts; capture phase so the terminal never sees them
document.addEventListener('keydown', (e) => {
  const open = !$('overview').hidden;
  const cmdB = e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b';
  const mods = e.ctrlKey || e.metaKey || e.altKey;
  const arrow = { ArrowLeft: -1, ArrowRight: 1 }[e.key] || (!mods && { j: -1, k: 1 }[e.key]); // j/k alias left/right
  if (!cmdB && !(open && (arrow || e.key === 'Escape'))) return;
  e.preventDefault();
  e.stopPropagation();
  if (arrow) moveFocus(arrow);
  else if (!e.repeat) open ? closeOverview() : openOverview(); // cmd+b toggles, escape closes
}, true);

fit.fit();
connect();
term.focus();
