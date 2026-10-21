#!/usr/bin/env sh
# 参数原样传给启动脚本，例如 ./start.sh --no-open 或 ./start.sh --rebuild
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "[SkyTavern] 没有找到 Node.js，请先安装 22.18 或更新的版本：https://nodejs.org/"
  exit 1
fi
exec node --disable-warning=ExperimentalWarning scripts/start.mjs "$@"
