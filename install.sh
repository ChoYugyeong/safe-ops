#!/usr/bin/env sh
# Install safe-ops as an agent skill.
#   ./install.sh                 -> ~/.claude/skills/safe-ops
#   ./install.sh /custom/dir     -> /custom/dir
set -eu

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-$HOME/.claude/skills/safe-ops}"

mkdir -p "$DEST"
cp "$SRC/SKILL.md" "$SRC/README.md" "$SRC/LICENSE" "$DEST/"
rm -rf "$DEST/bin"
cp -r "$SRC/bin" "$DEST/bin"

printf 'installed safe-ops -> %s\n' "$DEST"
printf 'try: node "%s/bin/safetrash.cjs" plan --path ./build\n' "$DEST"
