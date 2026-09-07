#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  dev-install.sh — Install the plugin for live development with dsh web.
#
#  Strategy: copy HOST bundles (need `dsh web` restart anyway), SYMLINK the
#  CLIENT bundle so dsh's client-hmr stat-polls the workspace file directly.
#  When `node build.mjs --watch` rewrites lib/client.js, client-hmr detects
#  the mtime change and pushes a hot-reload frame to the browser — no page
#  refresh needed.
#
#  Why not symlink the entire workspace? Because the workspace's own
#  node_modules/ contains devDependencies (@deepseek-ai/cordis etc.) that
#  would shadow the harness's shared copies and cause dual-instance errors
#  at runtime.
#
#  Usage:   ./dev-install.sh
#
#  After this finishes:
#    1. (Re)start dsh web                  — loads host changes
#    2. node build.mjs --watch             — watches src/client/** → lib/client.js
#       Client changes hot-reload in the browser automatically.
#
#  To push a host change without restarting dsh:
#    node build.mjs && ./dev-install.sh    — copies the new host bundle
#    Then restart dsh web.
#
#  To undo:
#    cd ~/.dsh/profiles/web
#    rm -rf node_modules/@vidge/dsh-agent-hub
#    edit package.json: set "@vidge/dsh-agent-hub" to a published version
#    pnpm install
# ---------------------------------------------------------------------------
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/web"
INSTALL_DIR="$PROFILE_DIR/node_modules/@vidge/dsh-agent-hub"

# ---------- 1. Build ----------
echo "==> Building plugin..."
node "$PLUGIN_DIR/build.mjs"

# ---------- 2. Replace install dir with hybrid structure ----------
# Remove whatever exists (old copy, full symlink, or prior hybrid)
if [ -L "$INSTALL_DIR" ] || [ -d "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
fi
mkdir -p "$INSTALL_DIR/lib"

# Copy package metadata
cp "$PLUGIN_DIR/package.json"    "$INSTALL_DIR/"
cp "$PLUGIN_DIR/cordis.patch.yml" "$INSTALL_DIR/"
cp "$PLUGIN_DIR/LICENSE"          "$INSTALL_DIR/" 2>/dev/null || true
cp "$PLUGIN_DIR/README.md"        "$INSTALL_DIR/" 2>/dev/null || true
cp "$PLUGIN_DIR/README.zh.md"     "$INSTALL_DIR/" 2>/dev/null || true

# Host bundles: COPY (needs dsh web restart to pick up changes)
cp "$PLUGIN_DIR/lib/index.js"        "$INSTALL_DIR/lib/"
cp "$PLUGIN_DIR/lib/index.js.map"    "$INSTALL_DIR/lib/"
cp "$PLUGIN_DIR/lib/invariant.js"    "$INSTALL_DIR/lib/"
cp "$PLUGIN_DIR/lib/invariant.js.map" "$INSTALL_DIR/lib/"

# Client bundle: SYMLINK (client-hmr detects changes → browser hot-reload)
ln -s "$PLUGIN_DIR/lib/client.js"     "$INSTALL_DIR/lib/client.js"
ln -s "$PLUGIN_DIR/lib/client.js.map" "$INSTALL_DIR/lib/client.js.map"

# Types (for any tooling that reads them)
if [ -d "$PLUGIN_DIR/lib/types" ]; then
  cp -R "$PLUGIN_DIR/lib/types" "$INSTALL_DIR/lib/types"
fi

# ---------- 3. Verify ----------
echo ""
echo "=== Setup complete ==="
echo ""
echo "  Profile:  $INSTALL_DIR"
echo "  Host:     copied  (lib/index.js, lib/invariant.js)"
echo "  Client:   symlinked (lib/client.js → workspace)"
echo ""
echo "Development workflow:"
echo "  1. Restart dsh web                  — loads the new host bundle"
echo "  2. node build.mjs --watch           — watches src/client/** → lib/client.js"
echo "     Client changes hot-reload in the browser automatically."
echo ""
echo "Publish to npm:"
echo "  npm version prerelease --preid rc   — bump version"
echo "  git push --follow-tags              — triggers GitHub Actions → npm publish"
echo ""
