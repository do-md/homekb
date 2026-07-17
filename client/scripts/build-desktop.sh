#!/bin/bash
# Signed + notarized desktop build (docs/ARCHITECTURE.md "App self-update").
# Produces, under src-tauri/target/<target>/release/bundle/:
#   macos/HomeKB.app                    — signed, notarized, stapled
#   macos/HomeKB_<arch>.app.tar.gz(.sig) — updater artifact + minisign signature
#   dmg/HomeKB_<arch>.dmg               — signed, notarized, stapled installer
#
# Requires .env.local (or env) with:
#   APPLE_SIGNING_IDENTITY       Developer ID Application: ...
#   APPLE_CERTIFICATE_BASE64     base64 of the .p12 certificate
#   APPLE_CERTIFICATE_PASSWORD   .p12 password
#   APPLE_API_ISSUER / APPLE_API_KEY / APPLE_API_KEY_BASE64   notarytool creds
#   TAURI_SIGNING_PRIVATE_KEY    minisign private key (content or path;
#                                ~/.tauri/homekb-updater.key)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Target triple — first arg, Apple Silicon only for now: the bundled engine
# binary (src-tauri resources, copied by tauri-build.mjs from
# engine/target/release/homekb) is built for the HOST arch. Shipping x86_64
# needs an x86_64 engine cross-build wired into tauri-build.mjs first.
TARGET="${1:-aarch64-apple-darwin}"
if [ "$TARGET" != "aarch64-apple-darwin" ]; then
  echo "Error: only aarch64-apple-darwin is supported for now (the bundled" >&2
  echo "       engine binary is host-arch; cross-building it is not wired up)." >&2
  exit 1
fi
ARCH="${TARGET%-apple-darwin}"

# ── Load .env.local if running locally ────────────────────────────────────────
if [ -f "$PROJECT_DIR/.env.local" ]; then
  set -a
  source "$PROJECT_DIR/.env.local"
  set +a
fi

# ── Validate required env vars ────────────────────────────────────────────────
for var in APPLE_SIGNING_IDENTITY APPLE_CERTIFICATE_BASE64 APPLE_CERTIFICATE_PASSWORD \
           APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_BASE64 \
           TAURI_SIGNING_PRIVATE_KEY; do
  if [ -z "${!var:-}" ]; then
    echo "Error: $var is not set" >&2
    exit 1
  fi
done

# ── Build the engine (release) — bundled into the .app by tauri-build.mjs ─────
# The engine crate lives at the repo root, one level above client/.
echo "Building engine (release)..."
(cd "$PROJECT_DIR/../engine" && cargo build --release)

# ── Decode secrets to temp files ──────────────────────────────────────────────
TMPDIR_BUILD=$(mktemp -d)
trap "rm -rf $TMPDIR_BUILD" EXIT

P12_PATH="$TMPDIR_BUILD/cert.p12"
P8_PATH="$TMPDIR_BUILD/AuthKey.p8"

echo "$APPLE_CERTIFICATE_BASE64" | base64 -d > "$P12_PATH"
echo "$APPLE_API_KEY_BASE64" | base64 -d > "$P8_PATH"

# ── Setup temp keychain ───────────────────────────────────────────────────────
KEYCHAIN_NAME="homekb-build.keychain-db"
KEYCHAIN_PASSWORD="homekb-build"

security delete-keychain "$KEYCHAIN_NAME" 2>/dev/null || true
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"
security set-keychain-settings -t 3600 "$KEYCHAIN_NAME"
security list-keychains -d user -s "$KEYCHAIN_NAME" login.keychain-db

security import "$P12_PATH" -k "$KEYCHAIN_NAME" -P "$APPLE_CERTIFICATE_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple:,codesign: \
  -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"

# ── Build the app (Tauri signs; we notarize + staple below) ───────────────────
# APPLE_API_KEY_PATH is deliberately not exported so Tauri only signs; a single
# notarization pass at the end covers the final bundle.
echo "Building HomeKB for $TARGET..."
cd "$PROJECT_DIR"
npx tauri build --target "$TARGET" --bundles app

APP_BUNDLE="$PROJECT_DIR/src-tauri/target/$TARGET/release/bundle/macos/HomeKB.app"
if [ ! -d "$APP_BUNDLE" ]; then
  echo "Error: expected .app at $APP_BUNDLE" >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"

# ── Notarize + staple the .app ───────────────────────────────────────────────
echo "Notarizing app..."
ZIP_PATH="$TMPDIR_BUILD/HomeKB.zip"
/usr/bin/ditto -c -k --keepParent "$APP_BUNDLE" "$ZIP_PATH"

xcrun notarytool submit "$ZIP_PATH" \
  --key "$P8_PATH" \
  --key-id "$APPLE_API_KEY" \
  --issuer "$APPLE_API_ISSUER" \
  --wait

xcrun stapler staple "$APP_BUNDLE"

# ── Package updater bundle (tar.gz of stapled .app + minisign signature) ─────
# Packaged AFTER stapling so the updater archive carries the notarization
# ticket. COPYFILE_DISABLE=1 + --no-mac-metadata stop macOS bsdtar from
# embedding AppleDouble "._*" members (serialized extended attributes —
# com.apple.provenance, com.dropbox.attrs, ...). `tar -tzf` hides those members
# from its own listing so the archive LOOKS clean, but the Tauri updater's Rust
# `tar` crate sees them raw and dies with "failed to unpack `._HomeKB.app`",
# breaking updates. (Pitfall inherited from DoMD's pipeline.)
echo "Packaging updater bundle..."
MACOS_DIR="$PROJECT_DIR/src-tauri/target/$TARGET/release/bundle/macos"
TAR_PATH="$MACOS_DIR/HomeKB_${ARCH}.app.tar.gz"
rm -f "$TAR_PATH" "$TAR_PATH.sig"
COPYFILE_DISABLE=1 tar --no-mac-metadata -czf "$TAR_PATH" -C "$MACOS_DIR" "HomeKB.app"

echo "Signing updater bundle with Tauri signer..."
npx tauri signer sign --password "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" "$TAR_PATH"
if [ ! -f "$TAR_PATH.sig" ]; then
  echo "Error: expected signature at $TAR_PATH.sig" >&2
  exit 1
fi

# ── Build DMG (with stapled .app + /Applications symlink) ────────────────────
echo "Building DMG..."
DMG_DIR="$PROJECT_DIR/src-tauri/target/$TARGET/release/bundle/dmg"
DMG_PATH="$DMG_DIR/HomeKB_${ARCH}.dmg"
mkdir -p "$DMG_DIR"
rm -f "$DMG_PATH"

DMG_STAGING="$TMPDIR_BUILD/dmg-staging"
mkdir -p "$DMG_STAGING"
cp -R "$APP_BUNDLE" "$DMG_STAGING/"
ln -s /Applications "$DMG_STAGING/Applications"

hdiutil create \
  -volname "HomeKB" \
  -srcfolder "$DMG_STAGING" \
  -ov -format UDZO \
  "$DMG_PATH"

# ── Sign + notarize + staple the DMG ─────────────────────────────────────────
echo "Signing DMG..."
codesign --force --sign "$APPLE_SIGNING_IDENTITY" \
  --options runtime --timestamp \
  "$DMG_PATH"

echo "Notarizing DMG..."
xcrun notarytool submit "$DMG_PATH" \
  --key "$P8_PATH" \
  --key-id "$APPLE_API_KEY" \
  --issuer "$APPLE_API_ISSUER" \
  --wait

xcrun stapler staple "$DMG_PATH"

# ── Cleanup keychain ─────────────────────────────────────────────────────────
security default-keychain -s login.keychain-db
security delete-keychain "$KEYCHAIN_NAME"

echo "Done:"
echo "  App:     $APP_BUNDLE"
echo "  Updater: $TAR_PATH"
echo "  DMG:     $DMG_PATH"
