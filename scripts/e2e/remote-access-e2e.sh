#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Markus remote-access — LOCAL end-to-end harness (T10)
#
# Proves the whole bring-your-own-tunnel path with REAL components:
#   • real Markus Hub (this repo's server, throwaway DB)
#   • real `cloudflared` quick tunnel pointing at a stand-in "my Markus" app
#   • real Hub ownership probe travelling out to the public internet and back
#   • real entry-domain auth gate (login redirect / ownership / 302)
#
# The data path never touches our server: the tunnel carries it. Run:
#   bash scripts/e2e/remote-access-e2e.sh
# Exits non-zero if any assertion fails.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

HUB_DIR="${HUB_DIR:-/Users/liuqian/.markus/agents/agt_b56cd6208342f8502d7bdd4d/worktrees/markus-hub-ra}"
MARKUS_DIR="${MARKUS_DIR:-/Users/liuqian/.markus/agents/agt_b56cd6208342f8502d7bdd4d/worktrees/markus-ra-t10}"
HUB_PORT="${HUB_PORT:-$(( 3100 + RANDOM % 800 ))}"
STUB_PORT="${STUB_PORT:-$(( 18000 + RANDOM % 800 ))}"
# Unique per run: re-runs must never collide on a left-over user or port.
USERNAME="${E2E_USER:-e2e$(date +%s)}"
PASSWORD="e2e-Passw0rd!23"
EMAIL="${USERNAME}@example.com"

WORK="$(mktemp -d /tmp/markus-e2e.XXXXXX)"
VERIFY_STATE="$WORK/verify.json"
PASS=0; FAIL=0

ok()   { printf '  \033[32m✅\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m❌\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
info() { printf '\033[36m▸\033[0m %s\n' "$1"; }
check_eq() { if [ "$2" = "$3" ]; then ok "$1 = $3"; else bad "$1 — expected [$3] got [$2]"; fi; }
check_ne() { if [ "$2" != "$3" ]; then ok "$1"; else bad "$1 — should not equal [$3]"; fi; }
check_ok() { if [ "$2" = "1" ]; then ok "$1"; else bad "$1"; fi; }

PIDS=()
cleanup() {
  info "tearing down"
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  pkill -f "tunnel-target-stub.mjs" 2>/dev/null || true
  pkill -f "cloudflared tunnel --url http://127.0.0.1:$STUB_PORT" 2>/dev/null || true
  # The Hub runs under `npx tsx` inside a subshell: killing the subshell PID can
  # leave the real server bound to the port. Kill by port — that is authoritative.
  if command -v lsof >/dev/null; then lsof -ti "tcp:$HUB_PORT" 2>/dev/null | xargs -r kill -9 2>/dev/null || true; fi
  sleep 1
  for p in "${PIDS[@]:-}"; do kill -9 "$p" 2>/dev/null || true; done
  [ "${KEEP_WORK:-0}" = "1" ] || rm -rf "$WORK"
}
trap cleanup EXIT

echo "═══ Markus remote access · local E2E ═══"
echo "work dir: $WORK"

# ── 0. preflight ─────────────────────────────────────────────────────────────
command -v cloudflared >/dev/null || { echo "cloudflared not found"; exit 2; }
[ -d "$HUB_DIR" ]    || { echo "hub dir missing: $HUB_DIR"; exit 2; }
[ -d "$MARKUS_DIR" ] || { echo "markus dir missing: $MARKUS_DIR"; exit 2; }

# ── 1. stand-in "my Markus" app + real cloudflared tunnel ────────────────────
info "1/7 starting the stand-in local app on :$STUB_PORT"
STUB_PORT="$STUB_PORT" STUB_STATE="$VERIFY_STATE" node "$MARKUS_DIR/scripts/e2e/tunnel-target-stub.mjs" >"$WORK/stub.log" 2>&1 &
PIDS+=($!)
sleep 1
curl -fsS "http://127.0.0.1:$STUB_PORT/" | grep -q MARKUS-LOCAL-APP-OK && ok "local app answers" || bad "local app did not answer"

info "2/7 starting a REAL cloudflared quick tunnel → :$STUB_PORT"
cloudflared tunnel --url "http://127.0.0.1:$STUB_PORT" --no-autoupdate >"$WORK/cf.log" 2>&1 &
PIDS+=($!)
CF_URL=""
for _ in $(seq 1 60); do
  CF_URL="$(grep -oE 'https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com' "$WORK/cf.log" | head -1 || true)"
  [ -n "$CF_URL" ] && break
  sleep 2
done
if [ -z "$CF_URL" ]; then
  bad "could not obtain a trycloudflare URL (see $WORK/cf.log)"; KEEP_WORK=1; echo "--- cf.log ---"; tail -30 "$WORK/cf.log"; exit 1
fi
ok "tunnel up: $CF_URL"

info "3/7 proving the DATA PATH goes through the user's tunnel (not our server)"
# A quick tunnel is printed before the edge/DNS has propagated — poll until the
# public hostname actually answers, then assert.
TUNNEL_ROOT="<not reachable>"
for _ in $(seq 1 30); do
  TUNNEL_ROOT="$(curl -fsS --max-time 15 "$CF_URL/" 2>/dev/null || echo '<not reachable>')"
  [ "$TUNNEL_ROOT" = "MARKUS-LOCAL-APP-OK" ] && break
  sleep 3
done
check_eq "public tunnel reaches the local app" "$TUNNEL_ROOT" "MARKUS-LOCAL-APP-OK"

# ── 2. real Hub ──────────────────────────────────────────────────────────────
info "4/7 starting the real Hub on :$HUB_PORT (throwaway DB)"
( cd "$HUB_DIR" && \
  DATABASE_PATH="$WORK/hub.db" \
  JWT_SECRET="e2e-hub-secret" \
  HUB_WEB_URL="https://www.markus.global" \
  ENTRY_HOST_SUFFIX="remote.markus.global" \
  PORT="$HUB_PORT" \
  npx tsx src/server/index.ts >"$WORK/hub.log" 2>&1 ) &
PIDS+=($!)

HUB="http://127.0.0.1:$HUB_PORT"
HUB_READY=0
for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$HUB/api/auth/email/available" || true)"
  if [ -n "$code" ] && [ "$code" != "000" ]; then HUB_READY=1; break; fi
  sleep 1
done
if [ "$HUB_READY" != "1" ]; then
  bad "hub did not become ready on $HUB (see $WORK/hub.log)"; KEEP_WORK=1; echo "--- hub.log ---"; tail -40 "$WORK/hub.log"; exit 1
fi
ok "hub ready on $HUB"

# ── 3. register the user (real auth path) ────────────────────────────────────
info "5/7 registering user '$USERNAME' and registering the endpoint"
REG_BODY="$WORK/register.json"
REG_CODE="$(curl -s -o "$REG_BODY" -D "$WORK/register.hdr" -w '%{http_code}' \
  -X POST "$HUB/api/auth/register" -H 'content-type: application/json' \
  -d "{\"username\":\"$USERNAME\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")"
TOKEN="$(grep -i '^set-cookie: hub_token=' "$WORK/register.hdr" | sed -E 's/.*hub_token=([^;]+).*/\1/' | tr -d '\r' | head -1)"
if [ -z "$TOKEN" ]; then
  TOKEN="$(python3 -c "import json,sys;d=json.load(open('$REG_BODY'));print(d.get('token') or d.get('accessToken') or '')" 2>/dev/null || true)"
fi
if [ -n "$TOKEN" ]; then ok "user registered (http $REG_CODE, session cookie captured)"; else
  bad "could not obtain a hub session token (http $REG_CODE)"; KEEP_WORK=1
  echo "--- body ---"; cat "$REG_BODY"; echo "--- headers ---"; cat "$WORK/register.hdr"; exit 1
fi

EP_BODY="$WORK/endpoint.json"
EP_CODE="$(curl -s -o "$EP_BODY" -w '%{http_code}' -X POST "$HUB/api/remote/endpoints" \
  -H 'content-type: application/json' -H "Cookie: hub_token=$TOKEN" \
  -d "{\"kind\":\"cloudflare_quick\",\"publicUrl\":\"$CF_URL\"}")"
if [ "$EP_CODE" = "200" ] || [ "$EP_CODE" = "201" ]; then ok "POST /api/remote/endpoints = $EP_CODE"; else bad "POST /api/remote/endpoints — expected 200/201 got $EP_CODE"; fi
EP_ID="$(python3 -c "import json;print(json.load(open('$EP_BODY')).get('endpointId',''))" 2>/dev/null || true)"
V_TOKEN="$(python3 -c "import json;print(json.load(open('$EP_BODY')).get('verifyToken',''))" 2>/dev/null || true)"
V_PATH="$(python3 -c "import json;print(json.load(open('$EP_BODY')).get('verifyPath',''))" 2>/dev/null || true)"
if [ -n "$EP_ID" ] && [ -n "$V_TOKEN" ] && [ -n "$V_PATH" ]; then
  ok "endpoint $EP_ID minted (verifyPath=$V_PATH)"
else
  bad "registration response missing fields"; cat "$EP_BODY"; KEEP_WORK=1; exit 1
fi

# Hand the probe answers to the stand-in app, then let the Hub probe it through
# the REAL public tunnel.
python3 - "$VERIFY_STATE" "$V_PATH" "$V_TOKEN" <<'PY'
import json, sys
json.dump({"verifyPath": sys.argv[2], "verifyToken": sys.argv[3]}, open(sys.argv[1], "w"))
PY

info "6/7 verification probe through the public tunnel"
VER_BODY="$WORK/verify-out.json"
VER_CODE="$(curl -s -o "$VER_BODY" -w '%{http_code}' -X POST "$HUB/api/remote/endpoints/$EP_ID/verify" \
  -H "Cookie: hub_token=$TOKEN")"
check_eq "POST /:id/verify (Hub → internet → tunnel → local app)" "$VER_CODE" "200"

# Activation happens on a SUCCESSFUL verify, so the public status must flip to
# `ready` without any further poke. Poll briefly to absorb probe latency.
STATUS="inactive"
for _ in $(seq 1 20); do
  STATUS="$(curl -s "$HUB/api/remote/entry/$USERNAME" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status','?'))" 2>/dev/null || echo '?')"
  [ "$STATUS" = "ready" ] && break
  sleep 1
done
check_eq "endpoint activated by the probe (public status)" "$STATUS" "ready"

# ── 4. entry gate ────────────────────────────────────────────────────────────
info "7/7 entry-domain auth gate + 302"
# Local stand-in for the Vercel edge rewrite `Host: {user}.<suffix>` → `?_remote_user=`.
ENTRY="$HUB/api?_remote_user=$USERNAME"

# (a) unauthenticated → login redirect, and NOTHING may leak the tunnel address.
HDR_A="$WORK/entry-anon.hdr"; BODY_A="$WORK/entry-anon.body"
CODE_A="$(curl -s -o "$BODY_A" -D "$HDR_A" -w '%{http_code}' "$ENTRY")"
check_eq "anonymous entry → 302" "$CODE_A" "302"
grep -qi 'location: .*auth/login' "$HDR_A" && ok "anonymous entry → login page" || bad "anonymous entry did not redirect to login"
if grep -q "$CF_URL" "$BODY_A" "$HDR_A" 2>/dev/null; then bad "S1 VIOLATION: tunnel address leaked to an anonymous visitor"; else ok "S1: no tunnel address in body or headers"; fi

# (b) the public T3 status endpoint: status only (S1).
ST_BODY="$WORK/entry-status.json"
ST_CODE="$(curl -s -o "$ST_BODY" -w '%{http_code}' "$HUB/api/remote/entry/$USERNAME")"
check_eq "GET /api/remote/entry/:username" "$ST_CODE" "200"
check_eq "  → status" "$(python3 -c "import json;print(json.load(open('$ST_BODY')).get('status',''))" 2>/dev/null || echo '?')" "ready"
if grep -q "$CF_URL" "$ST_BODY"; then bad "S1 VIOLATION: tunnel address in the public status body"; else ok "S1: status body carries no tunnel address"; fi

# (c) authenticated owner → 302 to the tunnel, Location verbatim (KNOWN BEHAVIOUR).
HDR_C="$WORK/entry-auth.hdr"; BODY_C="$WORK/entry-auth.body"
CODE_C="$(curl -s -o "$BODY_C" -D "$HDR_C" -w '%{http_code}' -H "Cookie: hub_token=$TOKEN" "$ENTRY")"
check_eq "authenticated entry → 302" "$CODE_C" "302"
LOC="$(grep -i '^location:' "$HDR_C" | head -1 | sed -E 's/^[Ll]ocation:[[:space:]]*//' | tr -d '\r')"
check_eq "  → Location is the tunnel URL, verbatim (no path/query appended)" "$LOC" "$CF_URL"

# (d) a different user must NOT be able to use someone else's entry.
OTHER="$(python3 -c "
import json,urllib.request,time
req=urllib.request.Request('$HUB/api/auth/register',data=json.dumps({'username':'intruder-$USERNAME','email':'intruder-$USERNAME@example.com','password':'$PASSWORD'}).encode(),headers={'content-type':'application/json'})
try:
    r=urllib.request.urlopen(req); print(r.headers.get('set-cookie',''))
except Exception as e:
    print('')
" | sed -E 's/.*hub_token=([^;]+).*/\1/' | tr -d '\r')"
if [ -n "$OTHER" ] && [ "$OTHER" != "$TOKEN" ]; then
  CODE_D="$(curl -s -o "$WORK/entry-intruder.body" -D "$WORK/entry-intruder.hdr" -w '%{http_code}' -H "Cookie: hub_token=$OTHER" "$ENTRY")"
  check_eq "another user's entry → 403" "$CODE_D" "403"
  if grep -q "$CF_URL" "$WORK/entry-intruder.body" "$WORK/entry-intruder.hdr" 2>/dev/null; then bad "S1 VIOLATION: tunnel address leaked to another user"; else ok "S1: no tunnel address for another user"; fi
else
  bad "could not register the intruder user (branch skipped)"
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo
echo "═══ RESULT: $PASS passed, $FAIL failed ═══"
[ "$FAIL" -eq 0 ] || { echo "(logs in $WORK)"; KEEP_WORK=1; exit 1; }
echo "artifact dir (removed on success): $WORK"
