// webtmux: browser ui for the windows of one tmux session
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const { parseArgs } = require('util');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');

const { values: opts } = parseArgs({
  options: {
    host: { type: 'string' }, // defaults to the tailscale ip
    port: { type: 'string', default: '7681' },
    session: { type: 'string', default: '0' },
    socket: { type: 'string' }, // tmux -L socket name, for a separate tmux server
  },
});

// drop tmux vars so attaching works when the server itself runs inside tmux
const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }; // colorterm is inherited by a tmux server we start
delete env.TMUX;
delete env.TMUX_PANE;
const tmuxBase = opts.socket ? ['-L', opts.socket] : [];

// runs a tmux command and resolves with its stdout
function tmux(...args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', [...tmuxBase, ...args], { env }, (err, out, errOut) => {
      if (err) reject(new Error(errOut.trim() || err.message));
      else resolve(out);
    });
  });
}

// asks tailscale for this machine's tailnet ipv4
function tailscaleIp() {
  try {
    return execFileSync('tailscale', ['ip', '-4']).toString().trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

// creates the managed session if it doesn't exist (e.g. after its last window was closed)
async function ensureSession() {
  // apps in new panes use truecolor (tmux downsamples for clients without it); with no server yet, one we start inherits it from env
  await tmux('set-environment', '-g', 'COLORTERM', 'truecolor').catch(() => {});
  try {
    await tmux('has-session', '-t', `=${opts.session}`);
  } catch {
    await tmux('new-session', '-d', '-s', opts.session, '-c', os.homedir(),
      ';', 'set-option', '-t', `${opts.session}:`, 'destroy-unattached', 'off').catch(() => {}); // may race with another connection
  }
}

// lists windows as seen by a web session, optionally with plain-text screen previews
async function listWindows(name, previews) {
  const out = await tmux('list-windows', '-t', `=${name}`, '-F', '#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{pane_width}\t#{pane_height}');
  const windows = out.split('\n').filter(Boolean).map((line) => {
    const [id, index, title, active, cols, rows] = line.split('\t');
    return { id, index: Number(index), name: title, active: active === '1', cols: Number(cols), rows: Number(rows) };
  });
  if (previews) {
    await Promise.all(windows.map(async (w) => {
      w.preview = (await tmux('capture-pane', '-p', '-t', w.id).catch(() => '')).trimEnd();
    }));
  }
  return windows;
}

// static files: the page plus xterm assets from node_modules
const staticFiles = {
  '/': ['public/index.html', 'text/html'],
  '/app.js': ['public/app.js', 'text/javascript'],
  '/style.css': ['public/style.css', 'text/css'],
  '/xterm.js': ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript'],
  '/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css'],
  '/addon-fit.js': ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript'],
  '/addon-webgl.js': ['node_modules/@xterm/addon-webgl/lib/addon-webgl.js', 'text/javascript'],
  '/addon-unicode11.js': ['node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js', 'text/javascript'],
};
for (const f of fs.readdirSync(path.join(__dirname, 'public/fonts')).filter((f) => f.endsWith('.woff2'))) {
  staticFiles[`/fonts/${f}`] = [`public/fonts/${f}`, 'font/woff2'];
}

const server = http.createServer((req, res) => {
  const file = staticFiles[req.url.split('?')[0]];
  if (!file) {
    res.writeHead(404).end();
    return;
  }
  const cache = file[1].startsWith('font/') ? 'max-age=604800' : 'no-cache'; // fonts never change, skip refetching them
  res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': cache });
  fs.createReadStream(path.join(__dirname, file[0])).pipe(res);
});

// only accept our own page, so other sites can't open a shell (websockets ignore same-origin);
// the host must be an ip, a single-label name, or a tailscale magicdns name, which blocks dns rebinding
const sameOrigin = ({ origin, req }) => {
  try {
    const url = new URL(origin);
    const trusted = /^(\d+\.\d+\.\d+\.\d+|\[[\da-f:]+\]|[\w-]+|[\w.-]+\.ts\.net)$/i.test(url.hostname);
    return trusted && url.host === req.headers.host;
  } catch {
    return false;
  }
};
const wss = new WebSocketServer({ server, path: '/ws', verifyClient: sameOrigin });

// each connection gets its own grouped session so its current window is independent
wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://x').searchParams;
  const clamp = (v, d) => Math.min(Math.max(Number(v) || d, 2), 1000);
  const cols = clamp(params.get('cols'), 80);
  const rows = clamp(params.get('rows'), 24);
  const startWin = params.get('win');
  const name = `webtmux-${crypto.randomBytes(4).toString('hex')}`;
  const validId = (id) => typeof id === 'string' && /^@\d+$/.test(id);
  let term = null;
  let closed = false;

  // sends the window list to the browser
  const sendWindows = async (previews, switched = false) => {
    const windows = await listWindows(name, previews).catch(() => null);
    if (windows && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'windows', windows, previews, switched }));
  };

  // create the web session detached, then attach a pty to it
  const ready = (async () => {
    await ensureSession();
    await tmux('new-session', '-d', '-t', `=${opts.session}`, '-s', name, '-c', os.homedir(),
      ';', 'set-option', '-t', `${name}:`, 'destroy-unattached', 'off', // enabled once attached
      ';', 'set-option', '-t', `${name}:`, 'status', 'off',
      ';', 'set-option', '-t', `${name}:`, 'detach-on-destroy', 'on', // never hop into another session
      // no tmux shortcuts in the browser: no prefix, and an empty key table instead of root
      ';', 'set-option', '-t', `${name}:`, 'prefix', 'None',
      ';', 'set-option', '-t', `${name}:`, 'prefix2', 'None',
      ';', 'set-option', '-t', `${name}:`, 'key-table', 'webtmux-none');
    // if the main session vanished just before, tmux made an unrelated group instead; bail and let the client reconnect
    const groupOf = (s) => tmux('display-message', '-p', '-t', `=${s}:`, '#{session_group}');
    if ((await groupOf(name)) !== (await groupOf(opts.session))) throw new Error('main session disappeared');
    if (validId(startWin)) await tmux('select-window', '-t', `=${name}:${startWin}`).catch(() => {}); // restore window after reconnect
    if (closed) throw new Error('closed');
    // destroy-unattached must be set after attaching or it fires immediately; -T tells tmux xterm.js does truecolor and synchronized output
    term = pty.spawn('tmux', ['-T', 'RGB,sync', ...tmuxBase, 'attach-session', '-t', `=${name}`, ';', 'set-option', 'destroy-unattached', 'on'], {
      name: 'xterm-256color', cols, rows, env, encoding: null,
    });
    term.onData((d) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(d);
      // backpressure: stop reading the pty while a slow link has >1MB queued (tmux copes with a stalled client)
      if (ws.bufferedAmount > 1 << 20) {
        term.pause();
        const wait = setInterval(() => {
          if (ws.bufferedAmount > 1 << 18 && ws.readyState === ws.OPEN) return;
          clearInterval(wait);
          term.resume();
        }, 50);
      }
    });
    term.onExit(() => ws.close());
    await sendWindows(false);
  })().catch((e) => {
    if (!closed) ws.close(1011, String(e.message).slice(0, 120));
  });

  const pane = `=${name}:`; // active pane of our current window
  let mayBeScrolled = true; // current pane may be in copy mode (after scrolling, switching windows, or reconnecting)

  let wheelRest = 0; // lines not yet sent as wheel notches to a mouse-aware app
  let wheelPane = null; // pane that wheelRest belongs to

  // scrolls history via copy mode (exits at the bottom), sends wheel events to mouse-aware apps like claude code,
  // or sends arrows to other fullscreen apps like vim/less
  const scroll = async (lines) => {
    const n = String(Math.min(Math.abs(Math.trunc(lines)), 500));
    if (n === '0') return;
    mayBeScrolled = true;
    const [id, alt, inMode, mouse, sgr, w, h] = (await tmux('display-message', '-p', '-t', pane,
      '#{pane_id} #{alternate_on} #{pane_in_mode} #{mouse_any_flag} #{mouse_sgr_flag} #{pane_width} #{pane_height}')).trim().split(' ');
    if (inMode !== '1' && mouse === '1' && sgr === '1') {
      // one sgr wheel event per notch (~3 lines), at the pane's center
      if (id !== wheelPane) [wheelPane, wheelRest] = [id, 0]; // don't carry leftovers into another pane
      wheelRest += Math.sign(lines) * Number(n);
      const notches = Math.trunc(wheelRest / 3);
      wheelRest -= notches * 3;
      if (!notches) return;
      const event = `\x1b[<${notches < 0 ? 64 : 65};${Math.ceil(w / 2)};${Math.ceil(h / 2)}M`;
      const hex = [...event.repeat(Math.abs(notches))].map((c) => c.charCodeAt(0).toString(16));
      await tmux('send-keys', '-t', pane, '-H', ...hex);
    } else if (inMode === '1') await tmux('send-keys', '-t', pane, '-X', '-N', n, lines < 0 ? 'scroll-up' : 'scroll-down');
    else if (alt === '1') await tmux('send-keys', '-t', pane, '-N', n, lines < 0 ? 'Up' : 'Down');
    else if (lines < 0) await tmux('copy-mode', '-e', '-t', pane, ';', 'send-keys', '-t', pane, '-X', '-N', n, 'scroll-up');
  };

  // handles one browser message; targets are qualified with our session so other sessions are never touched
  const handle = async (msg) => {
    if (!term) return;
    if (msg.t === 'in') {
      // typing jumps back to the live screen, like a normal terminal
      if (mayBeScrolled) {
        mayBeScrolled = false;
        await tmux('send-keys', '-t', pane, '-X', 'cancel').catch(() => {}); // fails harmlessly if not in copy mode
      }
      term.write(String(msg.d));
    } else if (msg.t === 'scroll') await scroll(Number(msg.lines) || 0);
    else if (msg.t === 'resize') term.resize(clamp(msg.cols, 80), clamp(msg.rows, 24));
    else if (msg.t === 'list') await sendWindows(!!msg.previews);
    else if (msg.t === 'select' && validId(msg.id)) {
      await tmux('select-window', '-t', `=${name}:${msg.id}`);
      mayBeScrolled = true;
      await sendWindows(false, true);
    } else if (msg.t === 'new') {
      await tmux('new-window', '-t', `=${name}:`, '-c', os.homedir());
      await sendWindows(false, true);
    } else if (msg.t === 'kill' && validId(msg.id)) {
      // unlink from our group only, so links in unrelated sessions survive
      await tmux('unlink-window', '-k', '-t', `=${name}:${msg.id}`);
      await sendWindows(true);
    }
  };

  // messages run in order so typing can't overtake a window switch
  let queue = ready;
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    queue = queue.then(() => handle(msg)).catch((e) => {
      console.error(`${name}: ${e.message}`);
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'error', msg: e.message }));
    });
  });

  // tear down the pty and the web session (its windows stay in the main session)
  // waits for setup so a session created mid-disconnect is still removed
  ws.on('close', async () => {
    closed = true;
    await ready;
    if (term) term.kill();
    tmux('kill-session', '-t', `=${name}`).catch(() => {});
  });
  ws.on('error', () => {}); // close follows; don't crash the server
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));
});

// drop connections that stop answering pings (e.g. a laptop that went offline)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 30000);

const host = opts.host || tailscaleIp();
if (!host) {
  console.error('no tailscale ip found; pass --host explicitly');
  process.exit(1);
}
server.listen(Number(opts.port), host, () => {
  console.log(`webtmux on http://${host}:${opts.port} (session "${opts.session}"${opts.socket ? `, socket ${opts.socket}` : ''})`);
});
