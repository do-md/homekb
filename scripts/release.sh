#!/bin/bash
# Manual desktop release pipeline (docs/ARCHITECTURE.md "App self-update").
# Driven by the "version" field in package.json.
#
# Usage:
#   1. Bump "version" in package.json (e.g. 0.1.0 -> 0.2.0)
#   2. Run this script:  ./scripts/release.sh
#
# It will:
#   - Read the new version from package.json
#   - Verify it differs from src-tauri/tauri.conf.json (terminates if same)
#   - Sync the new version into src-tauri/Cargo.toml and tauri.conf.json
#   - Run scripts/build-desktop.sh (signed + notarized; needs .env.local)
#   - Generate latest.json (the Tauri updater manifest)
#   - Commit + tag + push to origin
#   - Create a GitHub release with the DMG, updater tarball(.sig), latest.json
#
# Artifact names carry no version (HomeKB_aarch64.dmg, ...) so the
# releases/latest/download/... permalinks — including the updater endpoint in
# tauri.conf.json — stay valid across releases.
#
# Recovery: if the build fails after the version sync, reset with
#   git checkout -- package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

REPO_SLUG="do-md/homekb"

# ── Read versions ─────────────────────────────────────────────────────────────
NEW_VERSION=$(node -e "console.log(require('./package.json').version)")
OLD_VERSION=$(node -e "console.log(require('./src-tauri/tauri.conf.json').version)")

if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: package.json version '$NEW_VERSION' is not semver X.Y.Z" >&2
  exit 1
fi

if [ "$NEW_VERSION" = "$OLD_VERSION" ]; then
  echo "Error: package.json version ($NEW_VERSION) is unchanged." >&2
  echo "       Bump 'version' in package.json before running release." >&2
  exit 1
fi

TAG="v$NEW_VERSION"
echo "Releasing $TAG (previous: $OLD_VERSION)"

# ── Sanity ────────────────────────────────────────────────────────────────────
if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh CLI not found. Install with: brew install gh" >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "Error: gh not authenticated. Run: gh auth login" >&2
  exit 1
fi
if ! git remote get-url origin >/dev/null 2>&1; then
  echo "Error: no 'origin' remote. The updater endpoint expects $REPO_SLUG:" >&2
  echo "  gh repo create $REPO_SLUG --public --source . --remote origin --push" >&2
  exit 1
fi

# Allow package.json to be dirty (the user just bumped it). Reject anything else.
UNEXPECTED_DIRTY=$(git status --porcelain | awk '{print $NF}' | grep -v '^package\.json$' || true)
if [ -n "$UNEXPECTED_DIRTY" ]; then
  echo "Error: only package.json may have uncommitted changes. Also dirty:" >&2
  echo "$UNEXPECTED_DIRTY" >&2
  exit 1
fi

if git rev-parse --verify "$TAG" >/dev/null 2>&1; then
  echo "Error: tag $TAG already exists locally" >&2
  exit 1
fi
if git ls-remote --tags origin "refs/tags/$TAG" 2>/dev/null | grep -q "refs/tags/$TAG"; then
  echo "Error: tag $TAG already exists on origin" >&2
  exit 1
fi

# ── [1/4] Sync version into Cargo.toml + tauri.conf.json ─────────────────────
echo "[1/4] Syncing $NEW_VERSION into Cargo.toml and tauri.conf.json..."
sed -i '' -E "s/^version = \"[0-9]+\.[0-9]+\.[0-9]+\"/version = \"$NEW_VERSION\"/" src-tauri/Cargo.toml
sed -i '' -E "s/^  \"version\": \"[0-9]+\.[0-9]+\.[0-9]+\"/  \"version\": \"$NEW_VERSION\"/" src-tauri/tauri.conf.json

for f in src-tauri/Cargo.toml src-tauri/tauri.conf.json; do
  if ! grep -q "$NEW_VERSION" "$f"; then
    echo "Error: version sync did not apply to $f" >&2
    exit 1
  fi
done

# ── [2/4] Build signed + notarized artifacts ──────────────────────────────────
echo "[2/4] Building signed + notarized desktop app (this takes a while)..."
TARGET="aarch64-apple-darwin"
ARCH="${TARGET%-apple-darwin}"
"$SCRIPT_DIR/build-desktop.sh" "$TARGET"

DMG="$PROJECT_DIR/src-tauri/target/$TARGET/release/bundle/dmg/HomeKB_${ARCH}.dmg"
TAR="$PROJECT_DIR/src-tauri/target/$TARGET/release/bundle/macos/HomeKB_${ARCH}.app.tar.gz"
if [ ! -f "$DMG" ]; then
  echo "Error: expected DMG at $DMG" >&2
  exit 1
fi
if [ ! -f "$TAR" ] || [ ! -f "$TAR.sig" ]; then
  echo "Error: expected updater bundle at $TAR(.sig)" >&2
  exit 1
fi
SIG_AARCH64=$(cat "$TAR.sig")

# ── Generate latest.json (Tauri updater manifest) ────────────────────────────
LATEST_JSON="$PROJECT_DIR/src-tauri/target/latest.json"
PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
cat > "$LATEST_JSON" <<EOF
{
  "version": "$NEW_VERSION",
  "notes": "See https://github.com/$REPO_SLUG/releases/tag/$TAG",
  "pub_date": "$PUB_DATE",
  "platforms": {
    "darwin-aarch64": {
      "signature": "$SIG_AARCH64",
      "url": "https://github.com/$REPO_SLUG/releases/download/$TAG/HomeKB_aarch64.app.tar.gz"
    }
  }
}
EOF

# ── [3/4] Commit + tag + push ─────────────────────────────────────────────────
echo "[3/4] Committing + tagging + pushing..."
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
if git ls-files --error-unmatch src-tauri/Cargo.lock >/dev/null 2>&1; then
  git add src-tauri/Cargo.lock
fi
git commit -m "chore(release): $TAG"
git tag -a "$TAG" -m "HomeKB $TAG"
git push
git push origin "$TAG"

# ── [4/4] Create GitHub release ───────────────────────────────────────────────
echo "[4/4] Creating GitHub release $TAG..."
RELEASE_NOTES=$(cat <<'EOF'
> **Note:** Apple Silicon (aarch64) only for now.
EOF
)
gh release create "$TAG" \
  --title "HomeKB $TAG" \
  --notes "$RELEASE_NOTES" \
  --generate-notes \
  "$DMG" \
  "$TAR" \
  "$TAR.sig" \
  "$LATEST_JSON"

echo ""
echo "Done."
echo "  Tag:      $TAG"
echo "  DMG:      $DMG"
echo "  Updater:  $TAR"
echo "  Manifest: $LATEST_JSON"
echo "  Release:  $(gh release view "$TAG" --json url -q .url 2>/dev/null || echo "see GitHub")"
