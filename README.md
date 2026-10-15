# webtmux

Browser UI for one tmux session: a full terminal plus a windows overview (switch, create, close). Runs on the tmux machine and listens on its Tailscale IP only, so anything on your tailnet can reach it and nothing else can.

```
npm install
npm start                       # http://<tailscale-ip>:7681, manages session "0"
node server.js --session work --port 8000 --host 0.0.0.0
./restart.sh                    # (re)start in the background, logging to server.log; args go to server.js
```

Each browser tab gets its own grouped tmux session (`webtmux-xxxx`), so switching windows in the browser doesn't move your other attached terminals; windows themselves are shared. The grouped session is removed when the tab disconnects. If the managed session doesn't exist (e.g. you closed its last window) it's recreated. `--socket NAME` targets a separate tmux server (`tmux -L NAME`), handy for testing without touching your real session.

The browser's tmux client declares the `RGB` (truecolor) and `sync` (synchronized output) terminal features, and `COLORTERM=truecolor` is set in the tmux global environment so apps in new panes (e.g. Claude Code) use full color. The terminal uses xterm.js with its WebGL renderer, Unicode 11 widths, and a bundled JetBrains Mono (`public/fonts`, OFL licensed).
