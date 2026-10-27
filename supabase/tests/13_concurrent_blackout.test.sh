#!/usr/bin/env bash
# (as) Real concurrency for the blackout, using separate psql sessions.
#
# The last open squares of a board are crossed off at the same moment by
# different players: a blocker session holds the game row lock while they all
# start, so they queue on complete_square's game lock and are released
# together. Every completion must apply, and whichever lands last must see the
# others and end the game (status ended, end_reason blackout). With a lock that
# let completions run side by side (FOR SHARE), each would see the others'
# squares still open and the full board would stay live.
#
# Usage: 13_concurrent_blackout.test.sh <database url>   (called by scripts/db-test.sh)
set -uo pipefail

URL="$1"
ID="as"
DESC="concurrent completions of the last open squares serialize on the game lock: all apply and the game ends exactly once with end_reason blackout"
PLAYERS=6
export PGOPTIONS="-c client_min_messages=warning"

q() { psql -X -q -At -v ON_ERROR_STOP=1 "$URL" "$@"; }

workdir="$(mktemp -d)"
users=()

cleanup() {
  # Deleting the users cascades to the game they host and every player row.
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

mapfile -t users < <(q -c "select gen_random_uuid() from generate_series(1, $PLAYERS)")
[ ${#users[@]} -eq "$PLAYERS" ] || fail "could not generate users"
q -c "insert into auth.users (id) select unnest(array[$(printf "'%s'::uuid," "${users[@]}" | sed 's/,$//')])" >/dev/null ||
  fail "could not insert users"

as_user() { # <uuid> <sql>
  printf "begin;\nselect set_config('request.jwt.claims', '{\"sub\":\"%s\",\"role\":\"authenticated\"}', true) \\\\g /dev/null\nset local role authenticated;\n%s\ncommit;\n" "$1" "$2"
}

read -r game_id join_code < <(as_user "${users[0]}" "select id || ' ' || join_code from public.create_game('Blackout race', 'Host');" | q -f - | tr '|' ' ')
[ -n "${game_id:-}" ] && [ -n "${join_code:-}" ] || fail "create_game failed"
for i in $(seq 1 $((PLAYERS - 1))); do
  as_user "${users[$i]}" "select public.join_game('$join_code', 'Player $i') \\g /dev/null
select public.set_ready('$game_id', true) \\g /dev/null" | q -f - >/dev/null || fail "join/ready failed for player $i"
done
as_user "${users[0]}" "select public.set_ready('$game_id', true) \\g /dev/null
select public.start_game('$game_id') \\g /dev/null" | q -f - >/dev/null || fail "start failed"
# Skip the 5-second start countdown (completions wait for it: countdown_in_progress).
q -c "select tests.pass_countdown('$game_id')" >/dev/null || fail "could not skip the countdown"

# Everything but the last $PLAYERS squares (the free center is already done).
open_from=$((25 - PLAYERS))
as_user "${users[0]}" "select count(*) from generate_series(0, $((open_from - 1))) as p(pos), lateral public.complete_square('$game_id', p.pos) \\g /dev/null" |
  q -f - >/dev/null || fail "could not fill the board"
open="$(q -c "select count(*) from public.squares where game_id = '$game_id' and completed_at is null")"
[ "$open" = "$PLAYERS" ] || fail "expected $PLAYERS open squares, found $open"

# Hold the game lock so every completion queues behind it.
q -c "begin; select 1 from public.games where id = '$game_id' for update; select pg_sleep(2); commit;" >/dev/null 2>&1 &
blocker=$!
sleep 0.4

pids=()
for i in $(seq 0 $((PLAYERS - 1))); do
  as_user "${users[$i]}" "select 'applied=' || applied from public.complete_square('$game_id', $((open_from + i)));" |
    q -f - >"$workdir/$i.out" 2>&1 &
  pids+=($!)
done

sleep 1
waiting="$(q -c "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%complete_square%'")"

wait "$blocker"
for pid in "${pids[@]}"; do wait "$pid"; done

outputs="$(cat "$workdir"/*.out | grep -v '^CONTEXT:')"
applied=$(grep -c '^applied=true$' <<<"$outputs")
other=$(grep -v '^applied=true$' <<<"$outputs" | grep -c .)
open="$(q -c "select count(*) from public.squares where game_id = '$game_id' and completed_at is null")"
game="$(q -c "select status || ' ' || coalesce(end_reason, '-') || ' ' || (ended_at is not null) from public.games where id = '$game_id'")"

[ "${waiting:-0}" -ge 3 ] || fail "expected completions to be blocked concurrently, saw $waiting waiting"
[ "$other" -eq 0 ] || fail "unexpected output: $(grep -v '^applied=true$' <<<"$outputs" | head -3 | tr '\n' ' ')"
[ "$applied" -eq "$PLAYERS" ] || fail "expected $PLAYERS applied completions, got $applied"
[ "$open" = "0" ] || fail "expected a full board, $open squares open"
[ "$game" = "ended blackout true" ] || fail "game is '$game' (expected 'ended blackout true')"

echo "PASS ($ID) $DESC ($waiting completions queued on the lock)"
