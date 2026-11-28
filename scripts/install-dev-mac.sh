#!/bin/bash
# scripts/install-dev-mac.sh — the macOS counterpart of install-dev.ps1.
#
#   scripts/install-dev-mac.sh              link this checkout's panel/ into the user CEP extensions folder
#   scripts/install-dev-mac.sh --replace    the same, moving an installed (ZXP) copy aside first
#   scripts/install-dev-mac.sh --uninstall  remove the link only (never a real folder)
#
# Makes ~/Library/Application Support/Adobe/CEP/extensions/london.chroma.aemcp a symlink to
# <checkout>/panel and sets PlayerDebugMode=1 for CSXS 11, 12 and 13 (After Effects 2024-2027 read
# one of these). Restart After Effects afterwards.
#
# A real folder there is an installed ZXP. It is never deleted: without --replace the script stops;
# with --replace it is moved to ../london.chroma.aemcp.zxp-backup-<date> (the CEP folder, beside
# extensions/, NOT inside it: CEP loads every folder in extensions/ with this id, so a backup there
# would be loaded instead of the link), from where --uninstall --restore puts it back. Never install the ZXP over this link (DEVELOP.md): an installer
# could delete through it into the checkout.
set -euo pipefail

ID="london.chroma.aemcp"
EXT_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
TARGET="$EXT_DIR/$ID"
# Outside extensions/: CEP would load a copy left in there.
BACKUP_BASE="$(dirname "$EXT_DIR")/$ID.zxp-backup"
REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
PANEL="$REPO/panel"

mode="install"
restore=0
for a in "$@"; do
  case "$a" in
    --replace) mode="replace" ;;
    --uninstall) mode="uninstall" ;;
    --restore) restore=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "Unknown option: $a" >&2; exit 2 ;;
  esac
done

if [ "$(uname)" != "Darwin" ]; then
  echo "This script is for macOS; on Windows use scripts/install-dev.ps1." >&2
  exit 2
fi

if [ "$mode" = "uninstall" ]; then
  if [ -L "$TARGET" ]; then
    rm "$TARGET"
    echo "Removed the link $TARGET"
  elif [ -e "$TARGET" ]; then
    echo "$TARGET is a real folder (an installed copy), not a link: left alone." >&2
    exit 1
  else
    echo "No extension at $TARGET."
  fi
  if [ "$restore" = 1 ]; then
    latest="$(ls -d "$BACKUP_BASE"-* 2>/dev/null | sort | tail -1 || true)"
    if [ -n "$latest" ] && [ ! -e "$TARGET" ]; then
      mv "$latest" "$TARGET"
      echo "Restored the installed copy from $(basename "$latest")"
    else
      echo "No backup to restore, or something is already at $TARGET."
    fi
  fi
  exit 0
fi

if [ ! -f "$PANEL/CSXS/manifest.xml" ]; then
  echo "No panel/CSXS/manifest.xml under $REPO: run this from a chroma-ae-mcp checkout." >&2
  exit 1
fi

mkdir -p "$EXT_DIR"
if [ -L "$TARGET" ]; then
  rm "$TARGET"
elif [ -e "$TARGET" ]; then
  if [ "$mode" != "replace" ]; then
    echo "$TARGET is an installed copy (a real folder). Run with --replace to move it aside and link this checkout instead." >&2
    exit 1
  fi
  backup="$BACKUP_BASE-$(date +%Y%m%d-%H%M%S)"
  mv "$TARGET" "$backup"
  echo "Moved the installed copy to $backup"
fi
# A copy with this id anywhere else in extensions/ would be loaded instead of the link.
for other in "$EXT_DIR"/*; do
  [ "$other" = "$TARGET" ] && continue
  if [ -f "$other/CSXS/manifest.xml" ] && grep -q "ExtensionBundleId=\"$ID\"" "$other/CSXS/manifest.xml"; then
    echo "Warning: $other is another copy of $ID; CEP may load it instead of the link. Move it out of $EXT_DIR." >&2
  fi
done
ln -s "$PANEL" "$TARGET"
echo "Linked $TARGET -> $PANEL"

for v in 11 12 13; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1
done
echo "PlayerDebugMode=1 for CSXS 11, 12 and 13."
echo "Restart After Effects, then check Window > Extensions > Chroma AE MCP."
