"use client";

import { useMemo, useRef, useState } from "react";
import { FreeSpaceInfo } from "@/components/lobby/FreeSpaceInfo";
import { InviteBlock } from "@/components/lobby/InviteBlock";
import { LobbyBoard, type BoardSquare } from "@/components/lobby/LobbyBoard";
import { LobbyDock } from "@/components/lobby/LobbyDock";
import { LobbyHeader } from "@/components/lobby/LobbyHeader";
import { PlayerList } from "@/components/lobby/PlayerList";
import { SquareEditor } from "@/components/lobby/SquareEditor";
import { toSquareInput, type SquareFields } from "@/components/lobby/squareFields";
import { Sheet } from "@/components/ui/Sheet";
import { Toggle } from "@/components/ui/Toggle";
import { errorCopy, toGameError } from "@/lib/game/errors";
import { setFreeCenter, setReady, startGame, updateSquare } from "@/lib/game/rpc";
import { BOARD_SIZE, CENTER_POSITION, type Game, type Player, type Square } from "@/lib/game/types";
import type { SyncState } from "@/lib/game/useGame";

export type LobbyProps = {
  game: Game;
  players: Player[];
  squares: Square[];
  me: Player | null;
  syncState: SyncState;
  refresh: () => Promise<void>;
  applyGame: (row: Game) => void;
  applyPlayer: (row: Player) => void;
  applySquare: (row: Square) => void;
};

type Overlay<T> = { value: T; seq: number };
type Editing = { position: number; key: number; draft?: SquareFields; error?: string };

/**
 * The paper lobby: invite, players, the board everyone edits, Ready and
 * (host) Start. All changes go through the RPCs; this phone shows its own
 * change immediately (optimistic overlay) and then adopts the returned row.
 */
export function Lobby({ game, players, squares, me, syncState, refresh, applyGame, applyPlayer, applySquare }: LobbyProps) {
  const isHost = me !== null && me.user_id === game.host_user_id;
  const host = players.find((p) => p.user_id === game.host_user_id) ?? null;
  const hostName = host?.display_name ?? "";

  const seq = useRef(0);
  const [readyOverlay, setReadyOverlay] = useState<Overlay<boolean> | null>(null);
  const [freeOverlay, setFreeOverlay] = useState<Overlay<boolean> | null>(null);
  const [squareOverlays, setSquareOverlays] = useState<Record<number, Overlay<SquareFields>>>({});
  const [editing, setEditing] = useState<Editing | null>(null);
  const [centerOpen, setCenterOpen] = useState(false);
  const [startBusy, setStartBusy] = useState(false);
  const [dockError, setDockError] = useState<string | null>(null);
  const [freeError, setFreeError] = useState<string | null>(null);
  const editingRef = useRef<Editing | null>(null);
  const readySeq = useRef(0);
  const labelRef = useRef<HTMLInputElement>(null);

  const openEditor = (next: Editing | null) => {
    editingRef.current = next;
    setEditing(next);
  };

  const freeCenter = freeOverlay?.value ?? game.free_center;
  const myReady = readyOverlay?.value ?? me?.is_ready ?? false;
  const readyCount = players.filter((p) => (p.id === me?.id ? myReady : p.is_ready)).length;
  // Start uses server-confirmed state only (an in-flight Ready has not landed yet).
  const allReady = players.length > 0 && players.every((p) => p.is_ready) && readyOverlay === null;

  const board: BoardSquare[] = useMemo(() => {
    const byPosition = new Map(squares.map((s) => [s.position, s]));
    return Array.from({ length: BOARD_SIZE }, (_, position) => {
      const overlay = squareOverlays[position];
      const input = overlay ? toSquareInput(overlay.value) : null;
      const row = byPosition.get(position);
      return {
        position,
        label: input?.label ?? row?.label ?? "",
        target_count: input?.target_count ?? row?.target_count ?? 1,
        pending: overlay !== undefined,
      };
    });
  }, [squares, squareOverlays]);

  /** Any rejected action may mean our view is stale (e.g. the game started): resync. */
  const failed = (error: unknown): string => {
    void refresh();
    return errorCopy(error);
  };

  const toggleReady = async () => {
    if (!me) return;
    const value = !myReady;
    const id = ++seq.current;
    readySeq.current = id;
    setReadyOverlay({ value, seq: id });
    setDockError(null);
    try {
      applyPlayer(await setReady({ game_id: game.id, ready: value }));
    } catch (error) {
      // Only the latest tap reports; the overlay drops and the server state shows again.
      if (readySeq.current === id) setDockError(failed(error));
    } finally {
      setReadyOverlay((o) => (o?.seq === id ? null : o));
    }
  };

  const toggleFree = async (enabled: boolean) => {
    const id = ++seq.current;
    setFreeOverlay({ value: enabled, seq: id });
    setFreeError(null);
    try {
      applyGame(await setFreeCenter({ game_id: game.id, enabled }));
    } catch (error) {
      setFreeError(failed(error));
    } finally {
      setFreeOverlay((o) => (o?.seq === id ? null : o));
    }
  };

  const start = async () => {
    setStartBusy(true);
    setDockError(null);
    try {
      // Status becomes active: GameScreen leaves the lobby.
      applyGame(await startGame({ game_id: game.id }));
    } catch (error) {
      setDockError(failed(error));
      setStartBusy(false);
    }
  };

  const saveSquare = async (position: number, fields: SquareFields) => {
    const input = toSquareInput(fields);
    if (!input) return;
    const id = ++seq.current;
    setSquareOverlays((o) => ({ ...o, [position]: { value: fields, seq: id } }));
    openEditor(null);
    try {
      applySquare(await updateSquare({ game_id: game.id, position, ...input }));
    } catch (error) {
      const message = failed(error);
      const lobbyGone = toGameError(error).code === "game_not_in_lobby";
      // Give the typing back: reopen the sheet with the draft and the reason.
      if (!lobbyGone && editingRef.current === null) {
        openEditor({ position, key: ++seq.current, draft: fields, error: message });
      } else {
        setDockError(message);
      }
    } finally {
      setSquareOverlays((o) => {
        if (o[position]?.seq !== id) return o;
        const next = { ...o };
        delete next[position];
        return next;
      });
    }
  };

  const selectSquare = (position: number) => {
    if (position === CENTER_POSITION && freeCenter) {
      setFreeError(null);
      setCenterOpen(true);
      return;
    }
    openEditor({ position, key: ++seq.current });
  };

  const editingSquare = editing ? squares.find((s) => s.position === editing.position) : undefined;

  return (
    <div className="flex min-w-0 flex-col" data-testid="lobby">
      <LobbyHeader name={game.name} syncState={syncState} onResync={() => void refresh()} />
      <InviteBlock code={game.join_code} gameName={game.name} />
      <PlayerList
        players={players}
        meId={me?.id ?? null}
        hostUserId={game.host_user_id}
        readyOverride={readyOverlay?.value ?? null}
      />

      {isHost ? (
        <section className="mt-[28px] min-w-0" aria-label="Host settings">
          <Toggle
            checked={freeCenter}
            onChange={(enabled) => void toggleFree(enabled)}
            busy={freeOverlay !== null}
            label="Free space in the center"
            description={freeCenter ? "Starts crossed off for everyone." : "The center is a normal square."}
            testId="free-center-toggle"
          />
        </section>
      ) : null}
      {/* Shown to anyone: a rejected free-space change (e.g. not_host) gets its copy. */}
      {freeError && !centerOpen ? (
        <p role="alert" className="text-lg leading-7 text-danger" data-testid="free-center-error">
          {freeError}
        </p>
      ) : null}

      <LobbyBoard squares={board} freeCenter={freeCenter} onSelect={selectSquare} />

      {/* Room for the fixed dock so the last row is never hidden behind it. */}
      <div aria-hidden className={isHost || dockError ? "h-44" : "h-36"} />

      <LobbyDock
        ready={myReady}
        readyBusy={readyOverlay !== null}
        onToggleReady={() => void toggleReady()}
        isHost={isHost}
        hostName={hostName}
        allReady={allReady}
        readyCount={readyCount}
        playerCount={players.length}
        startBusy={startBusy}
        onStart={() => void start()}
        error={dockError}
      />

      <Sheet
        open={editing !== null}
        onClose={() => openEditor(null)}
        title={editing ? (editing.position === CENTER_POSITION ? "Center square" : `Square ${editing.position + 1}`) : ""}
        initialFocus={labelRef}
        testId="square-sheet"
      >
        {editing ? (
          <SquareEditor
            key={editing.key}
            square={editingSquare}
            draft={editing.draft}
            error={editing.error}
            labelRef={labelRef}
            onSave={(fields) => void saveSquare(editing.position, fields)}
            onCancel={() => openEditor(null)}
          />
        ) : null}
      </Sheet>

      <Sheet open={centerOpen} onClose={() => setCenterOpen(false)} title="Free space" testId="free-space-sheet">
        <FreeSpaceInfo
          isHost={isHost}
          hostName={hostName}
          freeCenter={freeCenter}
          busy={freeOverlay !== null}
          error={freeError}
          onToggle={(enabled) => {
            void toggleFree(enabled);
            // Turning it off makes the center editable: close so the player can tap it.
            if (!enabled) setCenterOpen(false);
          }}
        />
      </Sheet>
    </div>
  );
}
