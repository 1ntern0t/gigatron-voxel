#!/usr/bin/env bash
# Keeps the public lobby host running: restarts it whenever it exits (crash, OOM, kill), with a
# backoff that resets after a healthy minute, and makes sure the watchdog is running.
# Normally started by tools/lobby-ensure.sh. Settings: see tools/lobby-common.sh.
set -u
source "$(dirname "$0")/lobby-common.sh"
log="$log_dir/lobby-host.log"
if alive "$log_dir/lobby-supervisor.pid" lobby-supervise.sh && [ "$(cat "$log_dir/lobby-supervisor.pid")" != "$$" ]; then
  echo "supervisor already running (pid $(cat "$log_dir/lobby-supervisor.pid"))" >&2
  exit 0
fi
echo $$ > "$log_dir/lobby-supervisor.pid"
child=0
stop() {
  echo "$(date -Is) supervisor: stopping" >> "$log"
  if [ "$child" -gt 0 ]; then kill -TERM "$child" 2>/dev/null; while kill -0 "$child" 2>/dev/null; do sleep 0.2; done; fi
  rm -f "$log_dir/lobby-supervisor.pid" "$log_dir/lobby-host.pid"
  exit 0
}
trap stop INT TERM
# Waits while <pid> runs, re-spawning the watchdog if it ever dies.
watch_pid() {
  while kill -0 "$1" 2>/dev/null; do
    alive "$log_dir/lobby-watchdog.pid" lobby-watchdog.sh || start_detached lobby-watchdog.sh
    sleep 5 & wait $!
  done
}
# If a previous supervisor died but its host is still serving, adopt it instead of fighting it for the port.
if alive "$log_dir/lobby-host.pid" lobby-host.mjs; then
  orphan="$(cat "$log_dir/lobby-host.pid")"
  echo "$(date -Is) supervisor: adopting running lobby host pid $orphan" >> "$log"
  watch_pid "$orphan"
  echo "$(date -Is) supervisor: adopted lobby host $orphan exited" >> "$log"
fi
backoff=1
while true; do
  rotate "$log"
  echo "$(date -Is) supervisor: starting lobby host" >> "$log"
  started=$(date +%s)
  # shellcheck disable=SC2086
  node "$here/tools/lobby-host.mjs" --port "$port" --data "$data_dir" --log-dir "$log_dir" $host_args >> "$log" 2>&1 &
  child=$!
  echo "$child" > "$log_dir/lobby-host.pid"
  watch_pid "$child"
  wait "$child"
  code=$?
  echo "$(date -Is) supervisor: lobby host exited with code $code" >> "$log"
  if [ $(( $(date +%s) - started )) -gt 60 ]; then backoff=1; else backoff=$(( backoff * 2 > 60 ? 60 : backoff * 2 )); fi
  sleep "$backoff" & wait $!
done
