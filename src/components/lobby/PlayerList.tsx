"use client";

import { UserMinus } from "lucide-react";
import { useState } from "react";
import { PlayerSwatch } from "@/components/game/PlayerSwatch";
import { PencilCheck } from "@/components/lobby/PencilCheck";
import { PencilButton } from "@/components/ui/PencilButton";
import { MAX_PLAYERS, type Player } from "@/lib/game/types";

function Tag({ children }: { children: string }) {
  return (
    <span className="pencil-border-alt shrink-0 px-1.5 text-sm leading-5 text-ink-soft">{children}</span>
  );
}

/**
 * Everyone in the lobby: color, name, host / you tags and a pencil check when
 * ready. The host also gets a remove control on every other row (with an
 * inline confirm), so someone who wandered off can't keep Start locked.
 */
export function PlayerList({
  players,
  meId,
  hostUserId,
  readyOverride,
  onRemove,
  removeError,
}: {
  players: Player[];
  meId: string | null;
  hostUserId: string;
  /** My optimistic ready state while set_ready is in flight. */
  readyOverride: boolean | null;
  /** Host only: remove another player (`remove_player`). */
  onRemove?: (player: Player) => void;
  /** Why the last removal failed (the player is back in the list). */
  removeError?: string | null;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
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
          const isHost = p.user_id === hostUserId;
          const ready = isMe && readyOverride !== null ? readyOverride : p.is_ready;
          const removable = onRemove !== undefined && !isMe && !isHost;
          const confirming = removable && confirmId === p.id;
          return (
            <li
              key={p.id}
              data-testid="player"
              data-color={p.color}
              data-ready={ready}
              className="flex min-w-0 flex-col"
            >
              <div className="flex min-h-11 min-w-0 items-center gap-3">
                <PlayerSwatch color={p.color} />
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="min-w-0 truncate text-xl" data-testid="player-name">
                    {p.display_name}
                  </span>
                  {isHost ? <Tag>host</Tag> : null}
                  {isMe ? <Tag>you</Tag> : null}
                </span>
                {/* Before the ready box, so the ready column lines up with the host's own row. */}
                {removable ? (
                  <button
                    type="button"
                    onClick={() => setConfirmId(confirming ? null : p.id)}
                    aria-label={`Remove ${p.display_name}`}
                    aria-expanded={confirming}
                    data-testid="remove-player"
                    className="-mx-1.5 flex size-11 shrink-0 items-center justify-center text-ink-soft"
                  >
                    <UserMinus aria-hidden className="size-5" strokeWidth={2.25} />
                  </button>
                ) : null}
                <span
                  className="pencil-border inline-flex size-8 shrink-0 items-center justify-center"
                  data-testid="player-ready"
                >
                  {ready ? <PencilCheck className="size-6" /> : null}
                  <span className="sr-only">{ready ? "ready" : "not ready"}</span>
                </span>
              </div>
              {confirming ? (
                <div className="mb-1 flex min-w-0 flex-col gap-1 pl-9" data-testid="remove-player-panel">
                  <p className="min-w-0 text-lg leading-7 [overflow-wrap:anywhere]">
                    Remove {p.display_name} from the game?
                  </p>
                  <span className="flex flex-wrap items-center gap-2">
                    <PencilButton
                      variant="secondary"
                      onClick={() => {
                        setConfirmId(null);
                        onRemove?.(p);
                      }}
                      data-testid="remove-player-confirm"
                      className="px-4 text-lg"
                    >
                      Remove
                    </PencilButton>
                    <PencilButton
                      variant="quiet"
                      onClick={() => setConfirmId(null)}
                      data-testid="remove-player-cancel"
                      className="text-lg"
                    >
                      Cancel
                    </PencilButton>
                  </span>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {removeError ? (
        <p role="alert" className="text-lg leading-7 text-danger" data-testid="remove-player-error">
          {removeError}
        </p>
      ) : null}
    </section>
  );
}
