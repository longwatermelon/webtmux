#!/usr/bin/env bash
# restarts the webtmux server in the background, detached from this shell; extra args go to server.js
set -euo pipefail
cd "$(dirname "$0")"

# pids of servers started from this directory
servers() {
  for pid in $(pgrep -f '^node server\.js' || true); do
    if [ "$(readlink "/proc/$pid/cwd")" = "$PWD" ]; then echo "$pid"; fi
  done
}

# stop the running server and wait up to 5s for it to exit
old=$(servers)
if [ -n "$old" ]; then
  kill $old
  for _ in $(seq 10); do
    [ -z "$(servers)" ] && break
    sleep 0.5
  done
fi

# start detached so it survives logging out
setsid nohup npm start -- "$@" >> server.log 2>&1 < /dev/null &
sleep 2
if [ -n "$(servers)" ]; then
  tail -n 1 server.log
else
  echo "webtmux failed to start:" >&2
  tail -n 20 server.log >&2
  exit 1
fi
