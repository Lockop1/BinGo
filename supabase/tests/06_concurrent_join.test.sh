#!/usr/bin/env bash
# (t) Real concurrency for join_game, using separate psql sessions.
#
# A blocker session holds the game row lock while 14 joiners start; they all
# queue on join_game's SELECT ... FOR UPDATE and are then released together.
# Exactly 10 players must exist (host + 9) with distinct colors 0-9; the other
# 5 joiners must get 'game_full', and nobody may hit a unique violation.
#
# Usage: 06_concurrent_join.test.sh <database url>   (called by scripts/db-test.sh)
set -uo pipefail

URL="$1"
ID="t"
DESC="concurrent join_game calls serialize on the game lock: exactly 10 players, distinct colors, the rest get game_full"
JOINERS=14
export PGOPTIONS="-c client_min_messages=warning"

q() { psql -X -q -At -v ON_ERROR_STOP=1 "$URL" "$@"; }

workdir="$(mktemp -d)"
game_id=""
users=()

cleanup() {
  if [ -n "$game_id" ]; then
    q -c "delete from public.games where id = '$game_id'" >/dev/null 2>&1
  fi
  if [ ${#users[@]} -gt 0 ]; then
    q -c "delete from auth.users where id in ($(printf "'%s'," "${users[@]}" | sed 's/,$//'))" >/dev/null 2>&1
  fi
  rm -rf "$workdir"
}
trap cleanup EXIT

fail() {
  echo "FAIL ($ID) $DESC :: $*"
  exit 0
}

mapfile -t users < <(q -c "select gen_random_uuid() from generate_series(0, $JOINERS)")
[ ${#users[@]} -eq $((JOINERS + 1)) ] || fail "could not generate users"
q -c "insert into auth.users (id) select unnest(array[$(printf "'%s'::uuid," "${users[@]}" | sed 's/,$//')])" >/dev/null ||
  fail "could not insert users"

as_user() { # <uuid> <sql>
  printf "begin;\nselect set_config('request.jwt.claims', '{\"sub\":\"%s\",\"role\":\"authenticated\"}', true) \\\\g /dev/null\nset local role authenticated;\n%s\ncommit;\n" "$1" "$2"
}

read -r game_id join_code < <(as_user "${users[0]}" "select id || ' ' || join_code from public.create_game('Concurrency', 'Host');" | q -f - | tr '|' ' ')
[ -n "${game_id:-}" ] && [ -n "${join_code:-}" ] || fail "create_game failed"

# Hold the per-game lock so every joiner queues behind it.
q -c "begin; select 1 from public.games where id = '$game_id' for update; select pg_sleep(2); commit;" >/dev/null 2>&1 &
blocker=$!
sleep 0.4

pids=()
for i in $(seq 1 "$JOINERS"); do
  as_user "${users[$i]}" "select 'color=' || color from public.join_game('$join_code', 'Joiner $i');" |
    q -f - >"$workdir/$i.out" 2>&1 &
  pids+=($!)
done

sleep 1
waiting="$(q -c "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%join_game%'")"

wait "$blocker"
for pid in "${pids[@]}"; do wait "$pid"; done

# Each joiner prints either 'color=N' or psql's "ERROR:  game_full" (+ CONTEXT).
outputs="$(cat "$workdir"/*.out | grep -v '^CONTEXT:')"
joined=$(grep -c '^color=' <<<"$outputs")
full=$(grep -c '^psql:.*ERROR:  game_full$' <<<"$outputs")
other=$(grep -v '^color=' <<<"$outputs" | grep -v '^psql:.*ERROR:  game_full$' | grep -c .)
stats="$(q -c "select count(*) || ' ' || count(distinct color) || ' ' || min(color) || ' ' || max(color) from public.players where game_id = '$game_id'")"

[ "${waiting:-0}" -ge 5 ] || fail "expected joiners to be blocked concurrently, saw $waiting waiting"
[ "$stats" = "10 10 0 9" ] || fail "players/distinct colors/min/max = $stats"
[ "$joined" -eq 9 ] || fail "expected 9 successful joins, got $joined"
[ "$full" -eq $((JOINERS - 9)) ] || fail "expected $((JOINERS - 9)) game_full, got $full"
[ "$other" -eq 0 ] || fail "unexpected output: $(grep -v '^color=' <<<"$outputs" | grep -v 'game_full' | head -3 | tr '\n' ' ')"

echo "PASS ($ID) $DESC ($waiting joiners queued on the lock)"
