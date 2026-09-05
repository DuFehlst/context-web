#!/bin/bash
# Build: compile src/ → lib/ with TypeScript, then run `npm run build:client`
# (tsdown) to produce lib/client.js.
#
# Dependency source probe:
#   1. DSH_CHECKOUT  → a dsh source checkout (has packages/)
#   2. global dsh CLI → the installed @deepseek-ai/dsh package (node_modules)
# The script links @deepseek-ai/* packages from that source into this plugin's
# node_modules so tsc can resolve the DSH client/host type surface.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# --- locate a local tsc first (devDependencies installed) ---
TSC="$ROOT/node_modules/.bin/tsc"
if [ ! -x "$TSC" ] && [ ! -f "$TSC.cmd" ]; then
  CHECKOUT="${DSH_CHECKOUT:-}"
  if [ -z "$CHECKOUT" ]; then
    for candidate in "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness"; do
      if [ -d "$candidate/packages" ]; then CHECKOUT="$candidate"; break; fi
    done
  fi
  if [ -n "$CHECKOUT" ] && [ -x "$CHECKOUT/node_modules/.bin/tsc" ]; then
    TSC="$CHECKOUT/node_modules/.bin/tsc"
  else
    echo "build: tsc not found. Run 'npm install' first or set DSH_CHECKOUT." >&2
    exit 1
  fi
fi

# --- determine the @deepseek-ai package source ---
DSH_PKGS=""
if [ -n "${DSH_CHECKOUT:-}" ] && [ -d "$DSH_CHECKOUT/packages" ]; then
  DSH_PKGS="$DSH_CHECKOUT/node_modules/@deepseek-ai"
elif [ -d "$ROOT/node_modules/@deepseek-ai" ] && [ -n "$(ls -A "$ROOT/node_modules/@deepseek-ai" 2>/dev/null)" ]; then
  DSH_PKGS="$ROOT/node_modules/@deepseek-ai"
else
  GLOBAL_ROOT="$(npm root -g 2>/dev/null || true)"
  DSH_GLOBAL="$GLOBAL_ROOT/@deepseek-ai/dsh"
  if [ -d "$DSH_GLOBAL/node_modules/@deepseek-ai" ]; then
    DSH_PKGS="$DSH_GLOBAL/node_modules/@deepseek-ai"
  fi
fi
if [ -z "$DSH_PKGS" ] || [ ! -d "$DSH_PKGS" ]; then
  echo "build: cannot locate @deepseek-ai package sources (set DSH_CHECKOUT or install dsh globally)." >&2
  exit 1
fi

echo "=== Linking @deepseek-ai/* from $DSH_PKGS ==="
mkdir -p node_modules/@deepseek-ai
for pkg_dir in "$DSH_PKGS"/*; do
  [ -d "$pkg_dir" ] || continue
  pkg_name="$(basename "$pkg_dir")"
  link="$ROOT/node_modules/@deepseek-ai/$pkg_name"
  if [ ! -e "$link" ] && [ ! -L "$link" ]; then
    ln -s "$pkg_dir" "$link"
  fi
done

echo "=== Compiling src → lib ==="
"$TSC" -p tsconfig.json
echo "=== Build complete ==="
