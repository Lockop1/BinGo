import { PlayerSwatch } from "@/components/game/PlayerSwatch";
import { PencilCheck } from "@/components/lobby/PencilCheck";
import { MAX_PLAYERS, type Player } from "@/lib/game/types";

function Tag({ children }: { children: string }) {
  return (
    <span className="pencil-border-alt shrink-0 px-1.5 text-sm leading-5 text-ink-soft">{children}</span>
  );
}

/** Everyone in the lobby: color, name, host / you tags and a pencil check when ready. */
export function PlayerList({
  players,
  meId,
  hostUserId,
  readyOverride,
}: {
  players: Player[];
  meId: string | null;
  hostUserId: string;
  /** My optimistic ready state while set_ready is in flight. */
  readyOverride: boolean | null;
}) {
  const readyCount = players.filter((p) => (p.id === meId && readyOverride !== null ? readyOverride : p.is_ready)).length;
  return (
    <section className="mt-[28px] flex min-w-0 flex-col" aria-labelledby="players-heading">
      <div className="flex min-h-7 items-baseline justify-between gap-2">
        <h2 id="players-heading" className="text-2xl leading-7">
          Players{" "}
          <span className="text-ink-soft" data-testid="player-count">
            {players.length}/{MAX_PLAYERS}
          </span>
        </h2>
        <span className="text-lg leading-7 text-ink-soft" data-testid="ready-count">
          {readyCount} ready
        </span>
      </div>
      <ul className="mt-[7px] flex flex-col" data-testid="players">
        {players.map((p) => {
          const isMe = p.id === meId;
          const ready = isMe && readyOverride !== null ? readyOverride : p.is_ready;
          return (
            <li
              key={p.id}
              data-testid="player"
              data-color={p.color}
              data-ready={ready}
              className="flex min-h-11 min-w-0 items-center gap-3"
            >
              <PlayerSwatch color={p.color} />
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 truncate text-xl">{p.display_name}</span>
                {p.user_id === hostUserId ? <Tag>host</Tag> : null}
                {isMe ? <Tag>you</Tag> : null}
              </span>
              <span
                className="pencil-border inline-flex size-8 shrink-0 items-center justify-center"
                data-testid="player-ready"
              >
                {ready ? <PencilCheck className="size-6" /> : null}
                <span className="sr-only">{ready ? "ready" : "not ready"}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
