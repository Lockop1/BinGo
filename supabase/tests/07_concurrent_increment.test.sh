#!/usr/bin/env bash
# (v) Real concurrency for increment_square, using separate psql sessions.
#
# A blocker session holds the counter square's row lock while 10 sessions each
# send one +1 with a distinct action id, plus 2 sessions re-sending the first
# id (a retry racing the original). They all queue on increment_square's
# SELECT ... FOR UPDATE and are released together. Every distinct tap must
# count exactly once: current_count = 10 on the target-15 square, 10 calls
# applied, the 2 duplicates not applied, 10 rows in the action log.
#
# Usage: 07_concurrent_increment.test.sh <database url>   (called by scripts/db-test.sh)
set -uo pipefail

URL="$1"
ID="v"
DESC="concurrent increment_square calls with distinct action ids all count exactly once; a racing duplicate id counts once"
TAPS=10
DUPLICATES=2
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

mapfile -t users < <(q -c "select gen_random_uuid() from generate_series(1, 2)")
[ ${#users[@]} -eq 2 ] || fail "could not generate users"
q -c "insert into auth.users (id) select unnest(array[$(printf "'%s'::uuid," "${users[@]}" | sed 's/,$//')])" >/dev/null ||
  fail "could not insert users"

as_user() { # <uuid> <sql>
  printf "begin;\nselect set_config('request.jwt.claims', '{\"sub\":\"%s\",\"role\":\"authenticated\"}', true) \\\\g /dev/null\nset local role authenticated;\n%s\ncommit;\n" "$1" "$2"
}

read -r game_id join_code < <(as_user "${users[0]}" "select id || ' ' || join_code from public.create_game('Counter race', 'Host', true, '[{\"position\": 2, \"label\": \"Collect 15 signatures\", \"target_count\": 15}]');" | q -f - | tr '|' ' ')
[ -n "${game_id:-}" ] && [ -n "${join_code:-}" ] || fail "create_game failed"

as_user "${users[1]}" "select public.join_game('$join_code', 'Friend') \\g /dev/null
select public.set_ready('$game_id', true) \\g /dev/null" | q -f - >/dev/null || fail "join/ready failed"
as_user "${users[0]}" "select public.set_ready('$game_id', true) \\g /dev/null
select public.start_game('$game_id') \\g /dev/null" | q -f - >/dev/null || fail "start failed"

mapfile -t ids < <(q -c "select gen_random_uuid() from generate_series(1, $TAPS)")
[ ${#ids[@]} -eq "$TAPS" ] || fail "could not generate action ids"

# Hold the square's row lock so every tap queues behind it.
q -c "begin; select 1 from public.squares where game_id = '$game_id' and position = 2 for update; select pg_sleep(2); commit;" >/dev/null 2>&1 &
blocker=$!
sleep 0.4

pids=()
send() { # <n> <user> <action id>
  as_user "$2" "select 'applied=' || applied || ' count=' || current_count from public.increment_square('$game_id', 2, '$3');" |
    q -f - >"$workdir/$1.out" 2>&1 &
  pids+=($!)
}
for i in $(seq 0 $((TAPS - 1))); do
  send "$i" "${users[$((i % 2))]}" "${ids[$i]}"
done
for j in $(seq 1 "$DUPLICATES"); do
  send "dup$j" "${users[0]}" "${ids[0]}"
done

sleep 1
waiting="$(q -c "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%increment_square%'")"

wait "$blocker"
for pid in "${pids[@]}"; do wait "$pid"; done

outputs="$(cat "$workdir"/*.out | grep -v '^CONTEXT:')"
applied=$(grep -c '^applied=true ' <<<"$outputs")
not_applied=$(grep -c '^applied=false ' <<<"$outputs")
other=$(grep -v '^applied=' <<<"$outputs" | grep -c .)
row="$(q -c "select current_count || ' ' || (completed_at is null) from public.squares where game_id = '$game_id' and position = 2")"
logged="$(q -c "select count(*) || ' ' || count(distinct action_id) from public.square_increments where game_id = '$game_id'")"

[ "${waiting:-0}" -ge 5 ] || fail "expected taps to be blocked concurrently, saw $waiting waiting"
[ "$other" -eq 0 ] || fail "unexpected output: $(grep -v '^applied=' <<<"$outputs" | head -3 | tr '\n' ' ')"
[ "$row" = "$TAPS true" ] || fail "square count/open = $row (expected $TAPS true)"
[ "$applied" -eq "$TAPS" ] || fail "expected $TAPS applied taps, got $applied"
[ "$not_applied" -eq "$DUPLICATES" ] || fail "expected $DUPLICATES duplicates not applied, got $not_applied"
[ "$logged" = "$TAPS $TAPS" ] || fail "action log rows/distinct = $logged"

echo "PASS ($ID) $DESC ($waiting taps queued on the lock)"
