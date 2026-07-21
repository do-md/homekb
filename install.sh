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

# Put INSTALL_DIR on PATH persistently. install.sh targets ~/.local/bin, which is
# not on the default macOS PATH — so a fresh install would otherwise greet the
# user with `command not found: homekb`. Detect the login shell, append an
# idempotent line to its rc file (rustup/uv style), and fall back to a manual
# hint for shells we don't know how to configure.
add_to_path() {
  dir=$1
  shell_name=$(basename "${SHELL:-sh}")
  case "$shell_name" in
    zsh)
      rc="${ZDOTDIR:-$HOME}/.zshrc"
      line="export PATH=\"$dir:\$PATH\""
      ;;
    bash)
      # macOS Terminal runs bash as a login shell (.bash_profile); Linux
      # interactive shells read .bashrc.
      if [ "$(uname -s)" = "Darwin" ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi
      line="export PATH=\"$dir:\$PATH\""
      ;;
    fish)
      # fish has its own syntax + config location; `export PATH` does not apply.
      rc="$HOME/.config/fish/config.fish"
      line="fish_add_path $dir"
      mkdir -p "$(dirname "$rc")"
      ;;
    *)
      echo "note: $dir is not on your PATH. Add it to your shell profile:"
      echo "  export PATH=\"$dir:\$PATH\""
      return 0
      ;;
  esac
  if [ -f "$rc" ] && grep -qs -- "$dir" "$rc"; then
    echo "PATH: $rc already references $dir — left unchanged."
  else
    printf '\n# Added by the HomeKB installer\n%s\n' "$line" >> "$rc"
    echo "PATH: added $dir to $rc"
  fi
  echo "      Open a new terminal (or run: source $rc) to use homekb."
}

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;                # already on PATH — nothing to do
  *) add_to_path "$INSTALL_DIR" ;;
esac

echo "Get started:  homekb init && homekb reindex && homekb ask \"hello\""
