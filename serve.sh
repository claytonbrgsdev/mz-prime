#!/usr/bin/env bash

set -euo pipefail

# mz-prime dev server with auto-reload
#
# Usage:
#   ./serve.sh                 # Start server on PORT (default 5173)
#   PORT=8080 ./serve.sh       # Start on custom port
#   HOST=127.0.0.1 ./serve.sh  # Bind host (default 127.0.0.1)
#   OPEN_BROWSER=0 ./serve.sh  # Do not open browser automatically
#   LOG_FILE=/tmp/mz-prime.log ./serve.sh
#   ./serve.sh stop            # Stop any server on PORT (default 5173)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR"
PORT="${PORT:-5173}"
HOST="${HOST:-127.0.0.1}"
LOG_FILE="${LOG_FILE:-/tmp/mz-prime-dev-server.log}"
OPEN_BROWSER="${OPEN_BROWSER:-1}"
START_TIMEOUT_SECS="${START_TIMEOUT_SECS:-20}"

cd "$ROOT_DIR"

is_listening_on_port() {
  local port="$1"
  lsof -i TCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

find_free_port() {
  local candidate="$1"
  local max_tries=50
  local tries=0
  while is_listening_on_port "$candidate"; do
    candidate=$((candidate + 1))
    tries=$((tries + 1))
    if [ "$tries" -ge "$max_tries" ]; then
      echo "Error: Could not find a free port starting from $1 within $max_tries attempts." >&2
      exit 1
    fi
  done
  echo "$candidate"
}

stop_on_port() {
  local port="$1"
  local pids
  if pids="$(lsof -ti :"$port" || true)" && [ -n "$pids" ]; then
    echo "Stopping processes on port $port: $pids"
    # shellcheck disable=SC2086
    kill $pids || true
  else
    echo "No process found listening on port $port"
  fi
}

if [ "${1:-}" = "stop" ]; then
  stop_on_port "$PORT"
  exit 0
fi

# If requested port is busy, attempt to stop existing listener, then auto-pick next free port
if is_listening_on_port "$PORT"; then
  echo "Port $PORT is busy. Attempting to stop existing server(s)..."
  stop_on_port "$PORT"
  sleep 0.3
fi
PORT="$(find_free_port "$PORT")"

start_with_live_server() {
  # live-server provides auto reload for static files
  # --quiet to reduce noise, --no-browser optional (we handle opening)
  nohup npx --yes live-server \
    --port="$PORT" \
    --host="$HOST" \
    --watch="$ROOT_DIR" \
    --wait=0 \
    --no-browser \
    "$ROOT_DIR" >"$LOG_FILE" 2>&1 &
  echo $!
}

start_with_browser_sync() {
  # browser-sync also provides auto reload; use if live-server fails
  nohup npx --yes browser-sync start \
    --server "$ROOT_DIR" \
    --host "$HOST" \
    --port "$PORT" \
    --files "$ROOT_DIR/**/*" \
    --no-ui --no-notify >"$LOG_FILE" 2>&1 &
  echo $!
}

start_with_python() {
  # Fallback: no auto-reload, but ensures we can still serve
  nohup python3 -m http.server "$PORT" --bind "$HOST" --directory "$ROOT_DIR" >"$LOG_FILE" 2>&1 &
  echo $!
}

choose_and_start_server() {
  # Try live-server first (auto reload). If that fails, try browser-sync, then python.
  set +e
  start_with_live_server
  local pid=$!
  sleep 0.2
  if ! ps -p "$pid" >/dev/null 2>&1; then
    echo "live-server failed, trying browser-sync..." | tee -a "$LOG_FILE"
    start_with_browser_sync
    pid=$!
    sleep 0.2
    if ! ps -p "$pid" >/dev/null 2>&1; then
      echo "browser-sync failed, falling back to python http.server (no auto reload)." | tee -a "$LOG_FILE"
      start_with_python
      pid=$!
    fi
  fi
  set -e
  echo "$pid"
}

PID="$(choose_and_start_server)"

echo "Log file: $LOG_FILE"
echo "PID: $PID"
echo "Waiting for server to become available on http://$HOST:$PORT ..."

# Wait for server readiness
start_epoch="$(date +%s)"
until curl -sS -I "http://$HOST:$PORT/" >/dev/null 2>&1; do
  sleep 0.2
  now="$(date +%s)"
  if [ $((now - start_epoch)) -ge "$START_TIMEOUT_SECS" ]; then
    echo "Server did not become ready within $START_TIMEOUT_SECS seconds."
    echo "You can inspect logs with: tail -n +1 -f '$LOG_FILE'"
    exit 1
  fi
done

URL="http://$HOST:$PORT"
echo "Serving mz-prime at: $URL"
echo "To stop: ./serve.sh stop (or kill $PID)"

if [ "$OPEN_BROWSER" = "1" ]; then
  if command -v open >/dev/null 2>&1; then
    open "$URL" || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" || true
  fi
fi

exit 0
