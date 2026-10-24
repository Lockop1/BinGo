#!/usr/bin/env bash
# (ab) Real concurrency for play_again, using separate psql sessions.
#
# Every member of an ended game taps Play again at the same moment: a blocker
# session holds the old game's row lock while they all start, so they queue on
# play_again's SELECT ... FOR UPDATE and are released together. Exactly one
# rematch may exist afterwards, every caller must get that same game back, the
# old row must point at it, and only the first caller is in it.
#
# Usage: 09_concurrent_play_again.test.sh <database url>   (called by scripts/db-test.sh)
set -uo pipefail

URL="$1"
ID="ab"
DESC="concurrent play_again calls on one ended game serialize on the game lock: one rematch, every caller gets the same game"
MEMBERS=6
export PGOPTIONS="-c client_min_messages=warning"

q() { psql -X -q -At -v ON_ERROR_STOP=1 "$URL" "$@"; }

workdir="$(mktemp -d)"
users=()

cleanup() {
  # Deleting the users cascades to every game they host and every player row.
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

mapfile -t users < <(q -c "select gen_random_uuid() from generate_series(1, $MEMBERS)")
[ ${#users[@]} -eq "$MEMBERS" ] || fail "could not generate users"
q -c "insert into auth.users (id) select unnest(array[$(printf "'%s'::uuid," "${users[@]}" | sed 's/,$//')])" >/dev/null ||
  fail "could not insert users"

as_user() { # <uuid> <sql>
  printf "begin;\nselect set_config('request.jwt.claims', '{\"sub\":\"%s\",\"role\":\"authenticated\"}', true) \\\\g /dev/null\nset local role authenticated;\n%s\ncommit;\n" "$1" "$2"
}

read -r game_id join_code < <(as_user "${users[0]}" "select id || ' ' || join_code from public.create_game('Rematch race', 'Host');" | q -f - | tr '|' ' ')
[ -n "${game_id:-}" ] && [ -n "${join_code:-}" ] || fail "create_game failed"
for i in $(seq 1 $((MEMBERS - 1))); do
  as_user "${users[$i]}" "select public.join_game('$join_code', 'Member $i') \\g /dev/null" | q -f - >/dev/null ||
    fail "join_game failed for member $i"
done
# The host closes the lobby: an ended game.
as_user "${users[0]}" "select public.end_game('$game_id') \\g /dev/null" | q -f - >/dev/null || fail "end_game failed"

# Hold the game lock so every play_again queues behind it.
q -c "begin; select 1 from public.games where id = '$game_id' for update; select pg_sleep(2); commit;" >/dev/null 2>&1 &
blocker=$!
sleep 0.4

pids=()
for i in $(seq 0 $((MEMBERS - 1))); do
  as_user "${users[$i]}" "select 'game=' || id from public.play_again('$game_id');" | q -f - >"$workdir/$i.out" 2>&1 &
  pids+=($!)
done

sleep 1
waiting="$(q -c "select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%play_again%'")"

wait "$blocker"
for pid in "${pids[@]}"; do wait "$pid"; done

outputs="$(cat "$workdir"/*.out)"
answered=$(grep -c '^game=' <<<"$outputs")
distinct=$(grep '^game=' <<<"$outputs" | sort -u | wc -l)
returned=$(grep '^game=' <<<"$outputs" | head -1 | cut -d= -f2)
other=$(grep -v '^game=' <<<"$outputs" | grep -c .)
users_list="$(printf "'%s'," "${users[@]}" | sed 's/,$//')"
rematches="$(q -c "select count(*) from public.games where host_user_id in ($users_list) and id <> '$game_id'")"
pointer="$(q -c "select next_game_id || ' ' || next_join_code from public.games where id = '$game_id'")"
expected_pointer="$(q -c "select id || ' ' || join_code from public.games where id = '${returned:-00000000-0000-0000-0000-000000000000}'")"
new_players="$(q -c "select count(*) from public.players where game_id = '${returned:-00000000-0000-0000-0000-000000000000}'")"

[ "${waiting:-0}" -ge 3 ] || fail "expected callers to be blocked concurrently, saw $waiting waiting"
[ "$other" -eq 0 ] || fail "unexpected output: $(grep -v '^game=' <<<"$outputs" | head -3 | tr '\n' ' ')"
[ "$answered" -eq "$MEMBERS" ] || fail "expected $MEMBERS answers, got $answered"
[ "$distinct" -eq 1 ] || fail "callers got $distinct different games"
[ "$rematches" = "1" ] || fail "expected exactly one rematch, found $rematches"
[ -n "$expected_pointer" ] && [ "$pointer" = "$expected_pointer" ] || fail "old row points at '$pointer', expected '$expected_pointer'"
[ "$new_players" = "1" ] || fail "expected only the first caller in the rematch, found $new_players players"

echo "PASS ($ID) $DESC ($waiting callers queued on the lock)"
