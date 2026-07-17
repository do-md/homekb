#!/bin/sh
# HomeKB engine installer (docs/ARCHITECTURE.md "Distribution").
#
#   curl -fsSL https://raw.githubusercontent.com/do-md/homekb/main/install.sh | sh
#
# Detects OS/arch, downloads the latest `engine-v*` GitHub release, and
# installs the self-contained `homekb` binary to ~/.local/bin. No runtime
# dependencies (SQLite bundled, rustls TLS).
#
# Windows: this script is unix-only — install with Scoop
# (`scoop bucket add homekb https://github.com/do-md/scoop-bucket && scoop install homekb`)
# or download homekb-windows-x64.zip from the releases page.
set -eu

REPO="do-md/homekb"
INSTALL_DIR="${HOMEKB_INSTALL_DIR:-$HOME/.local/bin}"

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin)
    case "$arch" in
      arm64)  artifact="homekb-macos-arm64.tar.gz" ;;
      x86_64) artifact="homekb-macos-x64.tar.gz" ;;
      *) echo "error: unsupported macOS arch: $arch" >&2; exit 1 ;;
    esac ;;
  Linux)
    case "$arch" in
      x86_64) artifact="homekb-linux-x64.tar.gz" ;;
      *) echo "error: unsupported Linux arch: $arch (x86_64 only for now; build from source: cd engine && cargo build --release)" >&2; exit 1 ;;
    esac ;;
  *) echo "error: unsupported OS: $os" >&2; exit 1 ;;
esac

# Latest engine release = newest tag with the engine-v prefix. The repo also
# hosts desktop releases (v* tags), so releases/latest must not be used.
tag=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=30" |
  grep -o '"tag_name": *"engine-v[^"]*"' | head -1 | sed 's/.*"\(engine-v[^"]*\)"/\1/')
if [ -z "$tag" ]; then
  echo "error: no engine-v* release found in $REPO" >&2
  exit 1
fi

url="https://github.com/$REPO/releases/download/$tag/$artifact"
echo "Installing homekb engine $tag ($artifact)"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp/$artifact"
tar -xzf "$tmp/$artifact" -C "$tmp"

mkdir -p "$INSTALL_DIR"
# Remove before copy: on macOS, overwriting the same inode invalidates the
# kernel's code-signature cache and later execs get SIGKILLed.
rm -f "$INSTALL_DIR/homekb"
cp "$tmp/homekb" "$INSTALL_DIR/homekb"
chmod +x "$INSTALL_DIR/homekb"

echo "Installed: $INSTALL_DIR/homekb ($("$INSTALL_DIR/homekb" --version))"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "note: $INSTALL_DIR is not in PATH — add it to your shell profile:"
     echo "  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac

echo "Get started:  homekb init && homekb reindex && homekb ask \"hello\""
