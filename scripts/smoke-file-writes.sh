#!/usr/bin/env bash
# Smoke test for /api/files/write/* endpoints.
#
# Usage:
#   scripts/smoke-file-writes.sh [BASE_URL] [CWD]
#
# BASE_URL defaults to http://localhost:3030
# CWD defaults to a fresh directory under $TMPDIR.
#
# Exits 0 on success, non-zero on the first failing assertion.
# Not a replacement for unit tests — this is what MARVIN's test story looks
# like until an automated harness lands (see docs/development/testing.md).

set -euo pipefail

BASE_URL="${1:-http://localhost:3030}"
CWD="${2:-$(mktemp -d "${TMPDIR:-/tmp}/marvin-smoke-XXXXXX")}"

# Known-bad fixtures so we can verify sandbox rejections.
ESCAPE_PATH="/tmp/../etc/passwd"
SYMLINK_NAME="leak.txt"
SYMLINK_PATH="$CWD/$SYMLINK_NAME"

pass() { printf "\033[32m  ✓ %s\033[0m\n" "$1"; }
fail() { printf "\033[31m  ✗ %s\033[0m\n" "$1"; exit 1; }
note() { printf "\033[90m  · %s\033[0m\n" "$1"; }

req() {
  local method="$1" path="$2"
  shift 2
  curl -sS -X "$method" \
    -H "Content-Type: application/json" \
    "$@" \
    "$BASE_URL$path"
}

status() {
  local method="$1" path="$2"
  shift 2
  curl -sS -o /dev/null -w '%{http_code}' -X "$method" \
    -H "Content-Type: application/json" \
    "$@" \
    "$BASE_URL$path"
}

echo "MARVIN file-writes smoke test"
echo "  BASE_URL = $BASE_URL"
echo "  CWD      = $CWD"
echo

# ----------------------------------------------------------------------
# Sandbox rejections (expected 400)
# ----------------------------------------------------------------------
echo "Sandbox rejections:"

code=$(status POST /api/files/write/create \
  -d "{\"cwd\":\"$CWD\",\"path\":\"$ESCAPE_PATH\",\"kind\":\"file\"}")
[[ "$code" == "400" ]] && pass "create escapes cwd → 400" \
  || fail "create escape cwd returned $code"

ln -sfn /etc/passwd "$SYMLINK_PATH"
code=$(status GET "/api/files/content?cwd=$CWD&path=$SYMLINK_PATH")
[[ "$code" == "400" ]] && pass "content symlink → 400" \
  || fail "content symlink returned $code"
rm -f "$SYMLINK_PATH"

# ----------------------------------------------------------------------
# Create / save / rename happy paths
# ----------------------------------------------------------------------
echo
echo "Create / save / rename happy paths:"

NEW_FILE="$CWD/hello.txt"
req POST /api/files/write/create \
  -d "{\"cwd\":\"$CWD\",\"path\":\"$NEW_FILE\",\"kind\":\"file\",\"content\":\"hi\"}" \
  > /dev/null
[[ -f "$NEW_FILE" ]] && pass "create-file wrote $NEW_FILE" \
  || fail "create-file did not produce $NEW_FILE"

MTIME=$(curl -sS -X POST "$BASE_URL/api/files/write/save" \
  -H "Content-Type: application/json" \
  -d "{\"cwd\":\"$CWD\",\"path\":\"$NEW_FILE\",\"content\":\"updated\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["mtime"])')
note "save mtime = $MTIME"

code=$(status POST /api/files/write/save \
  -d "{\"cwd\":\"$CWD\",\"path\":\"$NEW_FILE\",\"content\":\"conflict\",\"expectedMtime\":0}")
[[ "$code" == "409" ]] && pass "save stale mtime → 409" \
  || fail "save stale mtime returned $code"

RENAMED_FILE="$CWD/hello.renamed.txt"
req POST /api/files/write/rename \
  -d "{\"cwd\":\"$CWD\",\"from\":\"$NEW_FILE\",\"to\":\"$RENAMED_FILE\"}" \
  > /dev/null
[[ -f "$RENAMED_FILE" && ! -f "$NEW_FILE" ]] && pass "rename ok" \
  || fail "rename did not move file"

# ----------------------------------------------------------------------
# Delete (trash — reversible)
# ----------------------------------------------------------------------
echo
echo "Delete → Trash:"

req POST /api/files/write/delete \
  -d "{\"cwd\":\"$CWD\",\"paths\":[\"$RENAMED_FILE\"],\"mode\":\"trash\"}" \
  > /dev/null
[[ ! -f "$RENAMED_FILE" ]] && pass "trash ok (check ~/.Trash)" \
  || fail "trash did not remove file"

# ----------------------------------------------------------------------
# Deny-list: create inside .git/
# ----------------------------------------------------------------------
echo
echo "Deny-list:"

mkdir -p "$CWD/.git"
code=$(status POST /api/files/write/create \
  -d "{\"cwd\":\"$CWD\",\"path\":\"$CWD/.git/hook\",\"kind\":\"file\"}")
[[ "$code" == "403" ]] && pass "create inside .git → 403" \
  || fail "create inside .git returned $code"

# ----------------------------------------------------------------------
# Confirm flow: permanent delete
# ----------------------------------------------------------------------
echo
echo "Confirm flow:"

DOOMED="$CWD/doomed.txt"
req POST /api/files/write/create \
  -d "{\"cwd\":\"$CWD\",\"path\":\"$DOOMED\",\"kind\":\"file\"}" > /dev/null

code=$(status POST /api/files/write/delete \
  -d "{\"cwd\":\"$CWD\",\"paths\":[\"$DOOMED\"],\"mode\":\"permanent\"}")
[[ "$code" == "409" ]] && pass "permanent delete without token → 409" \
  || fail "permanent delete no-token returned $code"

TOKEN=$(curl -sS -X POST "$BASE_URL/api/files/write/confirm" \
  -H "Content-Type: application/json" \
  -d "{\"cwd\":\"$CWD\",\"op\":{\"kind\":\"delete-permanent\",\"paths\":[\"$DOOMED\"]}}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
note "minted token (len=${#TOKEN})"

req POST /api/files/write/delete \
  -H "X-Marvin-Confirmed: $TOKEN" \
  -d "{\"cwd\":\"$CWD\",\"paths\":[\"$DOOMED\"],\"mode\":\"permanent\"}" > /dev/null
[[ ! -f "$DOOMED" ]] && pass "permanent delete with token ok" \
  || fail "permanent delete left file in place"

code=$(status POST /api/files/write/confirm \
  -d "{\"cwd\":\"$CWD\",\"op\":{\"kind\":\"delete-permanent\",\"paths\":[\"$CWD\"]}}")
[[ "$code" == "403" ]] && pass "confirm for project-root delete → 403" \
  || fail "project-root delete confirm returned $code"

echo
echo "All smoke assertions passed."
echo "Test cwd: $CWD  (keep it around for inspection or \`rm -rf\` it)."
