# Shared settings for the lobby keeper scripts (sourced, not run).
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log_dir="${LOBBY_LOG_DIR:-$here/logs}"
data_dir="${LOBBY_DATA:-$here/lobby-data}"
port="${LOBBY_PORT:-8787}"
# Extra lobby-host flags (e.g. "--static --trust-proxy"). --port/--data/--log-dir are added for you.
host_args="${LOBBY_ARGS:---static}"
rotate_bytes="${LOBBY_ROTATE_BYTES:-5242880}" # 5 MB
rotate_keep="${LOBBY_ROTATE_KEEP:-5}"
mkdir -p "$log_dir" "$data_dir"
export LOBBY_LOG_DIR="$log_dir" LOBBY_DATA="$data_dir" LOBBY_PORT="$port" LOBBY_ARGS="$host_args"

# alive <pidfile> <pattern>: the pid in the file is running AND its command line matches (no pid reuse).
alive() {
  local pid
  pid="$(cat "$1" 2>/dev/null)" || return 1
  [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q -- "$2"
}

# rotate <file>: copy-and-truncate when larger than rotate_bytes, keeping rotate_keep old copies.
# Copy-truncate is safe here because every writer appends (O_APPEND).
rotate() {
  local f="$1" i
  [ -f "$f" ] || return 0
  [ "$(stat -c %s "$f")" -gt "$rotate_bytes" ] || return 0
  for ((i = rotate_keep - 1; i >= 1; i--)); do [ -f "$f.$i" ] && mv -f "$f.$i" "$f.$((i + 1))"; done
  cp "$f" "$f.1" && : > "$f"
}

start_detached() { # start_detached <script> : fully detached from the calling shell
  setsid nohup "$here/tools/$1" >/dev/null 2>&1 < /dev/null &
}
