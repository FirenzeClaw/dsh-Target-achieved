#!/usr/bin/env bash
# 开发期把宿主的 @deepseek-ai 包链接到本地 node_modules，供 tsc 解析类型、供 node 运行测试。
# 宿主安装路径可用 DSH_INSTALL_DIR 覆盖。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_HOST="${HOME}/.nvm/versions/node/v24.22.1/lib/node_modules/@deepseek-ai/dsh"
HOST="${DSH_INSTALL_DIR:-$DEFAULT_HOST}"
PKGS="${HOST}/node_modules/@deepseek-ai"

if [[ ! -d "$PKGS" ]]; then
  echo "error: 未找到宿主包目录：$PKGS" >&2
  echo "提示：用 DSH_INSTALL_DIR=/path/to/@deepseek-ai/dsh 指定宿主安装位置" >&2
  exit 1
fi

mkdir -p "${REPO_ROOT}/node_modules"
rm -rf "${REPO_ROOT}/node_modules/@deepseek-ai"
ln -s "$PKGS" "${REPO_ROOT}/node_modules/@deepseek-ai"
echo "linked ${REPO_ROOT}/node_modules/@deepseek-ai -> ${PKGS}"
