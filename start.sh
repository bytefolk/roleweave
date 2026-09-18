#!/usr/bin/env bash
set -Eeuo pipefail

: "${PORT:?ASTEAM must provide PORT}"
case "$PORT" in
  ''|*[!0-9]*)
    printf 'RoleWeave: PORT must be numeric\n' >&2
    exit 64
    ;;
esac

product_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
runtime_dir="$product_dir/.runtime"
native_runtime="$product_dir/vendor/runtime"
display_number="$((100 + PORT % 1000))"
vnc_port="$((20000 + PORT % 20000))"
display=":$display_number"
runtime_libs="$native_runtime/lib/x86_64-linux-gnu:$native_runtime/usr/lib/x86_64-linux-gnu"

required_files=(
  "$product_dir/node_modules/electron/dist/electron"
  "$product_dir/deploy/node_modules/@novnc/novnc/core/rfb.js"
  "$product_dir/deploy/node_modules/ws/index.js"
  "$product_dir/deploy/mobile/ios/index.html"
  "$product_dir/deploy/mobile/android/index.html"
  "$product_dir/deploy/mobile/harmony/index.html"
  "$product_dir/deploy/mobile-surface.mjs"
  "$product_dir/apps/server/dist/src/index.js"
  "$product_dir/apps/desktop/dist/renderer/index.html"
  "$product_dir/apps/desktop/src/vendor/electron-updater.cjs"
  "$native_runtime/usr/bin/x11vnc"
)
for required_file in "${required_files[@]}"; do
  if [[ ! -e "$required_file" ]]; then
    printf 'RoleWeave: deployment is not built; missing %s\n' "$required_file" >&2
    printf 'Run bash scripts/build-deployment.sh from the product directory.\n' >&2
    exit 69
  fi
done

mkdir -p "$runtime_dir/user-data" "$runtime_dir/logs"

export ROLEWEAVE_PHONE_LINK_PORT="$PORT"
if [[ -z "${ROLEWEAVE_PHONE_LINK_HOST_TOKEN:-}" ]]; then
  ROLEWEAVE_PHONE_LINK_HOST_TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
  export ROLEWEAVE_PHONE_LINK_HOST_TOKEN
fi

child_pids=()
electron_pid=""
cleanup() {
  local pid
  trap - EXIT INT TERM HUP
  if [[ -n "$electron_pid" ]]; then
    kill -TERM -- "-$electron_pid" 2>/dev/null || true
  fi
  for pid in "${child_pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM HUP

export DISPLAY="$display"
export XDG_RUNTIME_DIR="$runtime_dir/xdg-$PORT"
if [[ -z "${ROLEWEAVE_DEFAULT_WORKSPACE:-}" && -f "$product_dir/examples/oss-maintainer/workspace.json" ]]; then
  export ROLEWEAVE_DEFAULT_WORKSPACE="$product_dir/examples/oss-maintainer"
fi
export ELECTRON_OZONE_PLATFORM_HINT=x11
export LD_LIBRARY_PATH="$runtime_libs${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export GSETTINGS_SCHEMA_DIR="$native_runtime/usr/share/glib-2.0/schemas"
export XDG_DATA_DIRS="$native_runtime/usr/share${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}:/usr/local/share:/usr/share"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

Xvfb "$display" -screen 0 1240x800x24 -nolisten tcp -ac \
  >"$runtime_dir/logs/xvfb.log" 2>&1 &
child_pids+=("$!")

for _ in $(seq 1 100); do
  [[ -S "/tmp/.X11-unix/X$display_number" ]] && break
  sleep 0.05
done
if [[ ! -S "/tmp/.X11-unix/X$display_number" ]]; then
  printf 'RoleWeave: X display failed to start\n' >&2
  exit 70
fi

"$native_runtime/usr/bin/x11vnc" -display "$display" -forever -shared \
  -nopw -localhost -rfbport "$vnc_port" -noxdamage -quiet \
  >"$runtime_dir/logs/x11vnc.log" 2>&1 &
child_pids+=("$!")

node "$product_dir/deploy/web-server.mjs" "$PORT" "$vnc_port" \
  >"$runtime_dir/logs/web-server.log" 2>&1 &
child_pids+=("$!")

cd "$product_dir"
setsid "$product_dir/node_modules/electron/dist/electron" \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --user-data-dir="$runtime_dir/user-data" \
  apps/desktop \
  >"$runtime_dir/logs/electron.log" 2>&1 &
electron_pid="$!"
child_pids+=("$electron_pid")

wait "$electron_pid"
