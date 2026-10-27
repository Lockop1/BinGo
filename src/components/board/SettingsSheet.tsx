"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { useDeadlineLine } from "@/components/board/PlayersSheet";
import { PencilButton } from "@/components/ui/PencilButton";
import type { Game } from "@/lib/game/types";
import type { BoardTheme, Settings, SquareSize, TextSize } from "@/lib/settings/settings";

type Option<T extends string> = {
  value: T;
  label: string;
  /** Second, smaller line under the label. */
  note?: string;
  /** Font size for the label (the text-size options preview themselves). */
  size?: string;
};

/**
 * One row of pencil-drawn choices (a radio group: arrow keys move the
 * choice, each option is a ≥44px tap target). Picking applies at once.
 */
function Segmented<T extends string>({
  label,
  name,
  options,
  value,
  onChange,
}: {
  label: string;
  name: string;
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const labelId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    const back = event.key === "ArrowLeft" || event.key === "ArrowUp";
    const step = forward ? 1 : back ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <h3 id={labelId} className="text-xl leading-7">
        {label}
      </h3>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        data-testid={`settings-${name}`}
        className="grid min-w-0 gap-2"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((option, index) => {
          const checked = option.value === value;
          return (
            <button
              key={option.value}
              ref={(node) => {
                refs.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              onClick={() => onChange(option.value)}
              onKeyDown={(event) => onKeyDown(event, index)}
              data-testid={`settings-${name}-${option.value}`}
              className={`flex min-h-12 min-w-0 flex-col items-center justify-center px-1.5 py-1.5 text-center leading-tight break-words focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
                checked
                  ? "pencil-border bg-highlight text-ink shadow-[2px_2px_0_var(--ink)]"
                  : "pencil-border-alt bg-paper text-ink-soft"
              }`}
            >
              <span style={{ fontSize: option.size ?? "1.125rem" }}>{option.label}</span>
              {option.note ? <span className="text-sm leading-4">{option.note}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const THEME_LABEL: Record<BoardTheme, string> = { scoreboard: "Dark Scoreboard", whiteboard: "Whiteboard" };

/** The host's game controls (BoardScreen passes them only on the host's phone). */
export type HostControls = {
  /** `end_game` is in flight. */
  ending: boolean;
  /** Copy for the last failed `end_game`. */
  error: string | null;
  onEndGame: () => void;
  /** Opens the extend sheet (once per game; hidden after `deadline_extended_at` is set). */
  onExtend: () => void;
};

/**
 * "Host": Extend deadline (once) and End game (with a confirm step). The RPCs
 * enforce both (`extend_deadline`, `end_game`: host only, live only, once);
 * nobody else's Settings ever shows this.
 */
function HostSection({ game, host }: { game: Game; host: HostControls }) {
  const headingId = useId();
  const [confirming, setConfirming] = useState(false);
  const extended = (game.deadline_extended_at ?? null) !== null;
  return (
    <section
      aria-labelledby={headingId}
      data-testid="settings-host"
      className="flex min-w-0 flex-col gap-2 border-b-2 border-dashed border-ink-faint pb-[14px]"
    >
      <h3 id={headingId} className="text-xl leading-7">
        Host
      </h3>
      {confirming ? (
        <>
          <p className="text-xl leading-7">End the game for everyone? The board locks and the album opens.</p>
          <div className="flex flex-wrap items-center gap-3">
            <PencilButton onClick={host.onEndGame} busy={host.ending} data-testid="end-game-confirm">
              End game
            </PencilButton>
            <PencilButton variant="quiet" onClick={() => setConfirming(false)} data-testid="end-game-cancel">
              Keep playing
            </PencilButton>
          </div>
        </>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          {!extended ? (
            <PencilButton variant="secondary" onClick={host.onExtend} data-testid="extend-deadline">
              Extend deadline
            </PencilButton>
          ) : null}
          <PencilButton variant="secondary" onClick={() => setConfirming(true)} data-testid="end-game">
            End game
          </PencilButton>
        </div>
      )}
      {extended && !confirming ? (
        <p className="text-lg leading-7 text-ink-soft" data-testid="deadline-extended">
          Deadline extended once
        </p>
      ) : null}
      {host.error ? (
        <p role="alert" className="text-lg leading-7 text-danger" data-testid="end-game-error">
          {host.error}
        </p>
      ) : null}
    </section>
  );
}

const TEXT_OPTIONS: Option<TextSize>[] = [
  { value: "normal", label: "Normal", size: "1.0625rem" },
  { value: "large", label: "Large", size: "1.25rem" },
  { value: "xlarge", label: "Extra large", size: "1.4375rem" },
];

const SQUARE_OPTIONS: Option<SquareSize>[] = [
  { value: "normal", label: "Normal", note: "square" },
  { value: "tall", label: "Tall", note: "room for text" },
];

/**
 * The board's menu. On the host's phone it opens with the "Host" section
 * (Extend deadline, End game); then the three board settings, for this phone
 * only. Changes show on the board behind the sheet straight away and are
 * saved (lib/settings). The theme follows the phone until another one is
 * picked; then a link brings the phone's choice back.
 */
export function SettingsSheetBody({
  game,
  settings,
  theme,
  systemTheme,
  onChange,
  host,
}: {
  game: Game;
  settings: Settings;
  /** The theme on screen (pinned or the phone's). */
  theme: BoardTheme;
  systemTheme: BoardTheme;
  onChange: (patch: Partial<Settings>) => void;
  /** Only on the host's phone: the Host section's controls. */
  host?: HostControls;
}) {
  const ends = useDeadlineLine(game.deadline_at);
  const themeOptions: Option<BoardTheme>[] = (["scoreboard", "whiteboard"] as const).map((value) => ({
    value,
    label: THEME_LABEL[value],
    note: value === systemTheme ? "(phone default)" : undefined,
  }));

  return (
    <div className="flex min-w-0 flex-col gap-[18px] pb-2" data-testid="settings-sheet-body">
      {host ? <HostSection game={game} host={host} /> : null}
      <div className="flex min-w-0 flex-col gap-1">
        <Segmented
          label="Board theme"
          name="theme"
          options={themeOptions}
          value={theme}
          onChange={(value) => {
            if (value !== theme) onChange({ theme: value });
          }}
        />
        {settings.theme !== null ? (
          <button
            type="button"
            onClick={() => onChange({ theme: null })}
            data-testid="settings-follow-system"
            className="-ml-2 inline-flex min-h-11 w-fit items-center px-2 text-lg text-ink-soft underline decoration-ink-faint decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-ink"
          >
            Follow phone setting
          </button>
        ) : null}
      </div>
      <Segmented
        label="Text size"
        name="text"
        options={TEXT_OPTIONS}
        value={settings.textSize}
        onChange={(value) => onChange({ textSize: value })}
      />
      <Segmented
        label="Square size"
        name="square"
        options={SQUARE_OPTIONS}
        value={settings.squareSize}
        onChange={(value) => onChange({ squareSize: value })}
      />
      <p className="text-base leading-[22px] text-ink-soft">Only on this phone. Everyone else keeps their own look.</p>
      {ends ? (
        <p className="text-lg leading-7 text-ink-soft" data-testid="settings-auto-end">
          {ends}
        </p>
      ) : null}
    </div>
  );
}
