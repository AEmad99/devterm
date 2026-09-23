#!/usr/bin/env bash
# Cloud Agent install for DevTerm (Linux x86_64 dev environment).
#
# DevTerm is a Windows-first Electron app whose repo `npm run setup`
# (scripts/setup-native.mjs) only auto-fetches the node-pty native addon for
# win32-x64 and mis-resolves the bundled Node runtime path on Linux. This
# script provisions the two Linux-x64 native artifacts up front, then defers to
# the repo's own setup for everything cross-platform (Electron binary + ONNX
# STT wasm). With the natives already in place `npm run setup` detects them and
# exits cleanly. Idempotent: safe to re-run against a warm node_modules.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
NM="$ROOT/node_modules"

echo "== npm install (scripts skipped; node-pty must never be rebuilt) =="
npm install --ignore-scripts

# Only the Linux x86_64 dev box needs the manual native provisioning below.
# On Windows/other arches the repo setup handles (or documents) the natives.
if [[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]]; then
  ELECTRON_VERSION="$(node -p "require('$NM/electron/package.json').version")"
  ELECTRON_ABI="v$(node -p "require('$NM/node-abi').getAbi('$ELECTRON_VERSION','electron')")"
  NODE_PTY_VER="$(node -p "require('$NM/node-pty/package.json').version")"

  PTY_REL="$NM/node-pty/build/Release"
  PTY_NODE="$PTY_REL/pty.node"
  PTY_MARKER="$PTY_REL/.devterm-abi"

  # node-pty native addon built for Electron's ABI (not Node's). The npm tarball
  # only bundles Node-ABI prebuilds, so pull the matching Electron prebuilt from
  # the same homebridge release the repo setup uses for Windows.
  if [[ -f "$PTY_NODE" && "$(cat "$PTY_MARKER" 2>/dev/null || true)" == "$ELECTRON_ABI" ]]; then
    echo "== node-pty native present (Electron ABI $ELECTRON_ABI) =="
  else
    PTY_URL="https://github.com/homebridge/node-pty-prebuilt-multiarch/releases/download/v${NODE_PTY_VER}/node-pty-prebuilt-multiarch-v${NODE_PTY_VER}-electron-${ELECTRON_ABI}-linux-x64.tar.gz"
    echo "== fetching node-pty prebuilt: $PTY_URL =="
    TMP_PTY="$(mktemp)"
    curl -fsSL "$PTY_URL" -o "$TMP_PTY"
    mkdir -p "$NM/node-pty/build"
    tar -xzf "$TMP_PTY" -C "$NM/node-pty"
    rm -f "$TMP_PTY"
    printf '%s\n' "$ELECTRON_ABI" > "$PTY_MARKER"
    [[ -f "$PTY_NODE" ]] || { echo "!! node-pty extract did not produce pty.node" >&2; exit 1; }
    echo "== node-pty native installed (Electron ABI $ELECTRON_ABI) =="
  fi

  # Bundled Node runtime for the DevTerm Agent, expected at node_modules/node/bin/node.
  NODE_PKG_VER="$(node -p "require('$NM/node/package.json').version")"
  BUNDLED_NODE="$NM/node/bin/node"
  if [[ -x "$BUNDLED_NODE" && "$("$BUNDLED_NODE" --version 2>/dev/null || true)" == "v$NODE_PKG_VER" ]]; then
    echo "== bundled Node runtime present (v$NODE_PKG_VER) =="
  else
    NODE_TARBALL="node-v${NODE_PKG_VER}-linux-x64.tar.xz"
    NODE_URL="https://nodejs.org/dist/v${NODE_PKG_VER}/${NODE_TARBALL}"
    echo "== fetching bundled Node runtime: $NODE_URL =="
    TMP_NODE_DIR="$(mktemp -d)"
    curl -fsSL "$NODE_URL" -o "$TMP_NODE_DIR/$NODE_TARBALL"
    curl -fsSL "https://nodejs.org/dist/v${NODE_PKG_VER}/SHASUMS256.txt" -o "$TMP_NODE_DIR/SHASUMS256.txt"
    (cd "$TMP_NODE_DIR" && grep " $NODE_TARBALL\$" SHASUMS256.txt | sha256sum -c -)
    tar -xJf "$TMP_NODE_DIR/$NODE_TARBALL" -C "$TMP_NODE_DIR"
    mkdir -p "$NM/node/bin"
    cp "$TMP_NODE_DIR/node-v${NODE_PKG_VER}-linux-x64/bin/node" "$BUNDLED_NODE"
    chmod +x "$BUNDLED_NODE"
    rm -rf "$TMP_NODE_DIR"
    [[ "$("$BUNDLED_NODE" --version)" == "v$NODE_PKG_VER" ]] || { echo "!! bundled Node runtime bad version" >&2; exit 1; }
    echo "== bundled Node runtime installed (v$NODE_PKG_VER, sha256 verified) =="
  fi
fi

# Fetch the Electron binary + copy ONNX STT wasm via the repo's own setup.
# With the natives already provisioned this detects them and exits 0.
echo "== npm run setup (Electron binary + ONNX wasm) =="
npm run setup

echo "== install complete =="
