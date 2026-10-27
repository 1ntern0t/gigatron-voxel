#!/usr/bin/env bash
# Watchdog for the public lobby. Every LOBBY_WATCH_SECS (60) it:
#  - runs the deep health check (HTTP, tick loop, all three bots present, real WebSocket probe);
#    after 3 failures in a row it kills the host (TERM, then KILL) so the supervisor restarts it;
#  - restarts the supervisor if it died;
#  - rotates lobby-host.log, lobby-incidents.log and lobby-watchdog.log.
set -u
source "$(dirname "$0")/lobby-common.sh"
wlog="$log_dir/lobby-watchdog.log"
if alive "$log_dir/lobby-watchdog.pid" lobby-watchdog.sh && [ "$(cat "$log_dir/lobby-watchdog.pid")" != "$$" ]; then
  exit 0
fi
echo $$ > "$log_dir/lobby-watchdog.pid"
trap 'rm -f "$log_dir/lobby-watchdog.pid"; exit 0' INT TERM
every="${LOBBY_WATCH_SECS:-60}"
fails=0
sleep 20 & wait $! # give a fresh host time to start
while true; do
  for f in lobby-host.log lobby-incidents.log lobby-watchdog.log; do rotate "$log_dir/$f"; done
  if ! alive "$log_dir/lobby-supervisor.pid" lobby-supervise.sh; then
    echo "$(date -Is) watchdog: supervisor not running, starting it" >> "$wlog"
    start_detached lobby-supervise.sh
    sleep 20 & wait $!
  fi
  if out="$(node "$here/tools/lobby-health.mjs" "http://127.0.0.1:$port" --deep 2>&1)"; then
    [ "$fails" -gt 0 ] && echo "$out (recovered)" >> "$wlog"
    fails=0
    # One OK line every ~30 minutes, so the log shows it is alive without growing fast.
    [ $(( $(date +%s) / every % 30 )) -eq 0 ] && echo "$out" >> "$wlog"
  else
    fails=$((fails + 1))
    echo "$out (failure $fails/3)" >> "$wlog"
    if [ "$fails" -ge 3 ]; then
      pid="$(cat "$log_dir/lobby-host.pid" 2>/dev/null)"
      if [ -n "$pid" ] && alive "$log_dir/lobby-host.pid" lobby-host.mjs; then
        echo "$(date -Is) watchdog: killing unhealthy lobby host pid $pid" >> "$wlog"
        kill -TERM "$pid" 2>/dev/null
        sleep 10 & wait $!
        alive "$log_dir/lobby-host.pid" lobby-host.mjs && [ "$(cat "$log_dir/lobby-host.pid")" = "$pid" ] && kill -KILL "$pid" 2>/dev/null
      fi
      fails=0
      sleep 20 & wait $!
    fi
  fi
  sleep "$every" & wait $!
done
