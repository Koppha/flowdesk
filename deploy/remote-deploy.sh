#!/usr/bin/env bash
# Runs on each PROD server. Invoked by GitLab CI as:
#   remote-deploy.sh <commit-sha>
# Expects backend.tar.gz, frontend.tar.gz and mobile-web.tar.gz in /tmp.
set -euo pipefail

SHA="${1:?usage: remote-deploy.sh <commit-sha>}"
APP_DIR="/opt/advance-clearance"
RELEASE_DIR="$APP_DIR/releases/$SHA"
KEEP_RELEASES=3

mkdir -p "$RELEASE_DIR/backend" "$RELEASE_DIR/frontend" "$RELEASE_DIR/mobile-web"

tar -xzf /tmp/backend.tar.gz -C "$RELEASE_DIR/backend"
tar -xzf /tmp/frontend.tar.gz -C "$RELEASE_DIR/frontend"
# The app's server-built screens: the backend serves <release>/mobile-web/dist
# (../mobile-web/dist from its working folder) at /mobile-app/web/.
tar -xzf /tmp/mobile-web.tar.gz -C "$RELEASE_DIR/mobile-web"
rm -f /tmp/backend.tar.gz /tmp/frontend.tar.gz /tmp/mobile-web.tar.gz

# Production env file lives outside the repo/release tree.
ln -sf /etc/advance-clearance/.env "$RELEASE_DIR/backend/.env"

(cd "$RELEASE_DIR/backend" && npm ci --omit=dev)

# Uploads (receipts, payback proofs, attachments, signed PDFs) live in one
# folder outside the releases, so a new release - or deleting an old one -
# never loses them. Files left inside earlier release folders are gathered
# into it first (never overwriting). The backend also keeps a copy of each
# file in the shared database so either PROD server can serve it.
SHARED_UPLOADS="$APP_DIR/shared/uploads"
mkdir -p "$SHARED_UPLOADS"
for old in "$APP_DIR"/releases/*/backend/uploads; do
  [ -d "$old" ] && [ ! -L "$old" ] && cp -an "$old"/. "$SHARED_UPLOADS"/ 2>/dev/null || true
done
rm -rf "$RELEASE_DIR/backend/uploads"
ln -sfn "$SHARED_UPLOADS" "$RELEASE_DIR/backend/uploads"

ln -sfn "$RELEASE_DIR" "$APP_DIR/current"

pm2 reload "$APP_DIR/ecosystem.config.cjs" --update-env

# Keep only the most recent $KEEP_RELEASES releases.
cd "$APP_DIR/releases"
ls -1t | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -rf --
