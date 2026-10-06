#!/usr/bin/env bash
#
# Checks that production is serving the endpoints the mobile app depends on.
#
# Written as a script because the check has to run right after a `docker service
# update`, and the deploy is done by hand on the server — waiting for someone
# else to run three curls in the right order is how a half-finished rollout gets
# mistaken for a working one.
#
# What each result means:
#   /health                     200 = the container is up and answering.
#   /admin-api/sessions/live    401 = route exists, credential not supplied.
#                               404 = the image predates the route (T06 or
#                                     earlier) and the app's live view cannot
#                                     poll. The update did not take effect.
#   /admin-api/sessions         401 = route exists; with a credential this is the
#                                     call that proves stored data is readable
#                                     after an upgrade.
#
# Usage:
#   tests/deploy/verify-production-app-endpoints.sh
#   BASE=https://code.apimesh.cn tests/deploy/verify-production-app-endpoints.sh
#
# Optional credential check (proves data readability, not just route presence):
#   COOKIE=<codebuddy_admin_session value> tests/deploy/verify-production-app-endpoints.sh
set -euo pipefail

BASE="${BASE:-https://code.apimesh.cn}"
COOKIE="${COOKIE:-}"

# The endpoint paths as the app calls them: no context prefix, the app posts to
# `<origin>/admin-api/...` directly.
status() {
  curl -s -m 15 -o /dev/null -w '%{http_code}' "$1" || echo '000'
}

fail=0
check() {
  local label="$1" actual="$2" expected="$3" note="${4:-}"

  if [[ "$actual" == "$expected" ]]; then
    printf '  ok    %-34s %s\n' "$label" "$actual"
    return
  fi

  fail=1
  printf '  FAIL  %-34s %s (expected %s)\n' "$label" "$actual" "$expected"

  if [[ -n "$note" ]]; then
    printf '        %s\n' "$note"
  fi
}

echo "== production endpoint check: $BASE =="

health="$(status "$BASE/health")"
check 'health' "$health" '200' 'the container is not answering; check `docker service ps`'

# Every route the mobile app calls. The list is deliberate rather than
# illustrative: a rolled-out image that restores the live view but drops a
# transcript read is still broken, and a probe of one endpoint would not say so.
#
# 401 is the expected unauthenticated answer (the route exists and rejects the
# missing credential); 405 is the same statement for a POST-only route reached
# with GET. 404 is the one that means "this image does not have the route".
live="$(status "$BASE/admin-api/sessions/live?conversationId=verify")"
check 'admin-api/sessions/live' "$live" '401' \
  '404 means the running image predates this route: the deploy did not take
        effect, so check `docker service ps codebuddy2api_app` for a rollback.'

sessions="$(status "$BASE/admin-api/sessions?windowMinutes=1440")"
check 'admin-api/sessions' "$sessions" '401' \
  'the session listing route is missing or erroring.'

transcripts="$(status "$BASE/admin-api/sessions/transcripts?conversationId=verify&limit=1")"
check 'admin-api/sessions/transcripts' "$transcripts" '401' \
  'the stored-question/answer listing route is missing or erroring.'

stream="$(status "$BASE/admin-api/sessions/stream?conversationId=verify")"
check 'admin-api/sessions/stream' "$stream" '401' \
  'the SSE route is missing; the browser build uses it.'

# POST-only, so a GET must come back as 405 rather than 404. Requesting it with
# GET keeps this probe free of side effects.
chat="$(status "$BASE/admin-api/chat/completions")"
check 'admin-api/chat/completions (GET)' "$chat" '405' \
  '405 is correct here (POST-only route); 404 means the ask endpoint is missing.'

if [[ -n "$COOKIE" ]]; then
  # A credential turns the two 401s above into real reads, which is what proves
  # data written before the upgrade is still readable after it.
  authed="$(curl -s -m 20 -o /tmp/.verify-sessions.json -w '%{http_code}' \
    -H "Cookie: codebuddy_admin_session=$COOKIE" \
    "$BASE/admin-api/sessions?windowMinutes=1440" || echo '000')"
  check 'admin-api/sessions (authed)' "$authed" '200' \
    '401 = the cookie is expired or not for this origin; 500 = a read failure,
        which after an upgrade usually means a stored document cannot be
        decrypted or parsed.'

  if [[ "$authed" == '200' ]]; then
    # The shape matters: `{"sessions":[...]}` with a parseable body is the
    # difference between "authorised" and "authorised but returning junk".
    if python3 -c "import json,sys; json.load(open('/tmp/.verify-sessions.json'))" 2>/dev/null; then
      printf '  ok    %-28s %s\n' 'sessions body parses' 'yes'
    else
      fail=1
      printf '  FAIL  %-28s %s\n' 'sessions body parses' 'no'
      head -c 200 /tmp/.verify-sessions.json
      echo
    fi
  fi

  rm -f /tmp/.verify-sessions.json
fi

echo
if [[ "$fail" == '0' ]]; then
  echo 'All checks passed.'
else
  echo 'Some checks failed (see above).' >&2
fi

exit "$fail"
