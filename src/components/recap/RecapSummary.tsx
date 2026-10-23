"use client";

import { Download, Play } from "lucide-react";
import { useState } from "react";
import { ColorChip } from "@/components/recap/ColorChip";
import { completedLines } from "@/components/recap/lines";
import { slug, squareTitle, type RecapItem } from "@/components/recap/recapItems";
import { downloadAllZip, type ZipProgress } from "@/components/recap/save";
import { PencilButton } from "@/components/ui/PencilButton";
import { BOARD_SIZE, type Game, type Player, type Square } from "@/lib/game/types";
import type { GetSignedUrls } from "@/lib/media/signedUrls";

type Props = {
  game: Pick<Game, "name" | "expires_at">;
  players: readonly Player[];
  squares: readonly Square[];
  items: readonly RecapItem[];
  names: readonly string[];
  getSignedUrls: GetSignedUrls;
  onWatch: () => void;
  /** "Night recap" is the page heading on the ended screen (h1), a section elsewhere (h2). */
  headingLevel?: "h1" | "h2";
};

/** "Saturday, November 22" in the viewer's locale. */
function longDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date(iso));
}

type ZipState = { kind: "idle" } | { kind: "working"; progress: ZipProgress | null } | { kind: "done"; failed: number } | { kind: "error" };

/** The paper "Night recap" card: totals, lines, who did what, the album deadline and its actions. */
export function RecapSummary({
  game,
  players,
  squares,
  items,
  names,
  getSignedUrls,
  onWatch,
  headingLevel: Heading = "h2",
}: Props) {
  const [zip, setZip] = useState<ZipState>({ kind: "idle" });
  const completed = squares.filter((s) => s.completed_at !== null).sort((a, b) => a.position - b.position);
  const lines = completedLines(squares);
  const counts = new Map<string, number>();
  for (const s of completed) {
    if (s.completed_by_player_id) counts.set(s.completed_by_player_id, (counts.get(s.completed_by_player_id) ?? 0) + 1);
  }
  const ranked = [...players].sort(
    (a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || a.joined_at.localeCompare(b.joined_at),
  );
  const playerById = new Map(players.map((p) => [p.id, p]));
  const hasMedia = items.length > 0;

  const downloadAll = async () => {
    setZip({ kind: "working", progress: null });
    try {
      const { failed } = await downloadAllZip({
        items,
        names,
        zipName: `${slug(game.name, "bingo-night")}-recap.zip`,
        getSignedUrls,
        onProgress: (progress) => setZip({ kind: "working", progress }),
      });
      setZip({ kind: "done", failed });
    } catch {
      setZip({ kind: "error" });
    }
  };

  return (
    <section className="flex min-w-0 flex-col gap-[14px]" aria-labelledby="recap-title" data-testid="recap-summary">
      <div className="min-w-0">
        <Heading id="recap-title" className="text-4xl leading-[56px] tracking-wide">
          Night recap
        </Heading>
        <p className="text-xl leading-7 break-words text-ink-soft">{game.name}</p>
      </div>

      <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="flex items-baseline gap-1" data-testid="recap-count" data-count={completed.length}>
          <span className="text-6xl leading-none tabular-nums">{completed.length}</span>
          <span className="text-3xl leading-none tabular-nums text-ink-soft">/{BOARD_SIZE}</span>
          <span className="ml-1 text-xl leading-7">squares</span>
        </p>
        <p className="text-xl leading-7" data-testid="recap-lines" data-lines={lines.length}>
          {lines.length === 12
            ? "Blackout: all 12 lines"
            : lines.length > 0
              ? `${lines.length} bingo ${lines.length === 1 ? "line" : "lines"}`
              : "No bingo lines this time"}
        </p>
      </div>
      {lines.length > 0 && lines.length < 12 ? (
        <p className="-mt-2 text-lg leading-7 break-words text-ink-soft">{lines.join(", ")}</p>
      ) : null}

      <ul className="flex min-w-0 flex-col" aria-label="Players">
        {ranked.map((p) => {
          const n = counts.get(p.id) ?? 0;
          return (
            <li key={p.id} className="flex min-h-7 min-w-0 items-center gap-2 text-xl leading-7" data-testid="recap-player">
              <ColorChip color={p.color} />
              <span className="min-w-0 flex-1 truncate">{p.display_name}</span>
              <span className="shrink-0 tabular-nums text-ink-soft" data-testid="recap-player-count">
                {n} {n === 1 ? "square" : "squares"}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="flex min-w-0 flex-col">
        <p className="text-xl leading-7" data-testid="recap-expiry">
          Album available until {longDate(game.expires_at)}
        </p>
        <p className="text-lg leading-7 text-ink-soft">Save before it&apos;s gone.</p>
      </div>

      {hasMedia ? (
        <div className="flex min-w-0 flex-col gap-2">
          <PencilButton onClick={onWatch} data-testid="recap-watch" className="w-full">
            <Play aria-hidden className="size-5" strokeWidth={2.25} />
            Watch the recap
          </PencilButton>
          <PencilButton
            variant="secondary"
            onClick={() => void downloadAll()}
            busy={zip.kind === "working"}
            data-testid="recap-download-all"
            className="w-full"
          >
            <Download aria-hidden className="size-5" strokeWidth={2.25} />
            Download all
          </PencilButton>
          <p aria-live="polite" className="min-h-7 text-lg leading-7" data-testid="recap-download-status">
            {zip.kind === "working"
              ? zip.progress
                ? `Zipping ${zip.progress.done}/${zip.progress.total}…`
                : "Getting the album…"
              : zip.kind === "done"
                ? zip.failed > 0
                  ? `Downloaded. ${zip.failed} couldn't be fetched.`
                  : "Downloaded."
                : zip.kind === "error"
                  ? "Couldn't download the album. Check your connection and try again."
                  : null}
          </p>
          <p className="text-base leading-[22px] text-ink-soft" data-testid="recap-download-note">
            On iPhone a zip can be clunky to open. Saving each photo from the recap is the easier way.
          </p>
        </div>
      ) : (
        <div className="flex min-w-0 flex-col" data-testid="recap-no-media">
          <p className="text-xl leading-7">No photos or videos this time.</p>
          {completed.length > 0 ? (
            <ul className="mt-1 flex min-w-0 flex-col" aria-label="Completed squares">
              {completed.map((s) => {
                const by = s.completed_by_player_id ? playerById.get(s.completed_by_player_id) : undefined;
                return (
                  <li key={s.id} className="flex min-h-7 min-w-0 items-center gap-2 text-lg leading-7" data-testid="recap-square-row">
                    <span className="min-w-0 flex-1 break-words">{squareTitle(s)}</span>
                    {by ? (
                      <span className="flex shrink-0 items-center gap-1.5 text-ink-soft">
                        <ColorChip color={by.color} className="size-4" />
                        {by.display_name}
                      </span>
                    ) : (
                      <span className="shrink-0 text-ink-soft">on the house</span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      )}
    </section>
  );
}
