#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/noan-hbt/rbx-studio-plus.git"
TAR_URL="https://github.com/noan-hbt/rbx-studio-plus/archive/refs/heads/main.tar.gz"
INSTALL_DIR="${RBX_PLUS_DIR:-$HOME/.local/share/rbx-studio-plus}"

fail() {
  printf "\n✘ %s\n" "$1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js (>= 20) is required. Install it from https://nodejs.org"
command -v npm >/dev/null 2>&1 || fail "npm is required."

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js >= 20 is required (found $(node -v))."
fi

echo "Installing rbx-studio-plus into $INSTALL_DIR ..."
mkdir -p "$(dirname "$INSTALL_DIR")"

if command -v git >/dev/null 2>&1; then
  if [ -d "$INSTALL_DIR/.git" ]; then
    echo "Updating existing repository..."
    git -C "$INSTALL_DIR" pull --ff-only
  else
    rm -rf "$INSTALL_DIR"
    git clone --depth 1 "$REPO" "$INSTALL_DIR"
  fi
else
  echo "git not found — downloading archive..."
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  curl -fsSL "$TAR_URL" -o "$TMP_DIR/repo.tar.gz"
  tar -xzf "$TMP_DIR/repo.tar.gz" -C "$TMP_DIR"
  rm -rf "$INSTALL_DIR"
  mv "$TMP_DIR/rbx-studio-plus-main" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
echo "Installing npm dependencies & building..."
npm install --no-audit --no-fund
npm run build

# Best-effort global CLI (`rbx-studio-plus`)
npm link --silent >/dev/null 2>&1 || true

EXTRA_ARGS=()
if [ "$#" -gt 0 ]; then
  EXTRA_ARGS=("$@")
elif [ -n "${RBX_PLUS_INSTALL_ARGS:-}" ]; then
  read -r -a EXTRA_ARGS <<< "$RBX_PLUS_INSTALL_ARGS"
fi

node dist/src/index.js install "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"
echo ""
node dist/src/index.js doctor
echo ""
echo "✔ rbx-studio-plus installed! Restart Claude Code / Codex, then open Roblox Studio with 'Enable Studio as MCP server' turned on."
