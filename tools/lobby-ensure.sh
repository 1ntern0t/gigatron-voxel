#!/usr/bin/env bash
# Idempotent "make sure the lobby is up": starts the supervisor (which starts the host and the
# watchdog) only if it is not already running, then prints a deep health check.
# Safe to run as often as you like - e.g. from cron @reboot / every 5 minutes, a systemd user
# timer, or any scheduler. Stop everything with: tools/lobby-ensure.sh stop
set -u
source "$(dirname "$0")/lobby-common.sh"
if [ "${1:-}" = "stop" ]; then
  for p in watchdog supervisor; do
    alive "$log_dir/lobby-$p.pid" "lobby-$( [ $p = supervisor ] && echo supervise || echo watchdog ).sh" && kill -TERM "$(cat "$log_dir/lobby-$p.pid")"
  done
  echo "stopped"
  exit 0
fi
started=0
if ! alive "$log_dir/lobby-supervisor.pid" lobby-supervise.sh; then
  start_detached lobby-supervise.sh
  started=1
fi
alive "$log_dir/lobby-watchdog.pid" lobby-watchdog.sh || { sleep 1; alive "$log_dir/lobby-watchdog.pid" lobby-watchdog.sh || start_detached lobby-watchdog.sh; }
for i in $(seq 1 20); do
  node "$here/tools/lobby-health.mjs" "http://127.0.0.1:$port" --deep >/dev/null 2>&1 && break
  sleep 1
done
[ "$started" = 1 ] && echo "started supervisor"
echo "supervisor pid $(cat "$log_dir/lobby-supervisor.pid" 2>/dev/null) | host pid $(cat "$log_dir/lobby-host.pid" 2>/dev/null) | watchdog pid $(cat "$log_dir/lobby-watchdog.pid" 2>/dev/null)"
node "$here/tools/lobby-health.mjs" "http://127.0.0.1:$port" --deep
