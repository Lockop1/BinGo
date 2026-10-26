"use client";

import { Pencil } from "lucide-react";
import { useCallback, useId, useState } from "react";
import { DeadlinePicker, DeadlineSummary } from "@/components/deadline/DeadlinePicker";
import { PencilButton } from "@/components/ui/PencilButton";
import { Sheet } from "@/components/ui/Sheet";
import { fromIso, validateDeadline } from "@/lib/deadline/presets";
import { useNow } from "@/lib/deadline/useNow";

/**
 * The lobby's deadline line, under the game name: "Ends Sun 11:59 PM · 2d 4h"
 * ("Passed" once it has gone by). The host gets a pencil "Change" control that
 * opens a sheet with the deadline picker; nothing is sent until Save (the
 * picker's own mount / drift `onChange` only fills the draft). Everyone else
 * sees the text only (`set_deadline` is host-only in SQL anyway).
 */
export function LobbyDeadline({
  deadlineIso,
  isHost,
  pending,
  error,
  onSave,
}: {
  /** What to show: the server's `deadline_at`, or this phone's unconfirmed change. */
  deadlineIso: string;
  isHost: boolean;
  /** A change from this phone is on its way to the server. */
  pending: boolean;
  /** Copy for the last rejected change. */
  error: string | null;
  onSave: (nextIso: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // The picker's value while the sheet is open; null = let it pick Tonight.
  const [draft, setDraft] = useState<string | null>(null);
  const [sheetKey, setSheetKey] = useState(0);
  const headingId = useId();
  const now = useNow(15_000);
  const onDraft = useCallback((iso: string) => setDraft(iso), []);

  const openSheet = () => {
    const current = fromIso(deadlineIso);
    // A passed (or too close) deadline is no starting point: the picker falls back to Tonight.
    setDraft(current && validateDeadline(current, new Date()) === "ok" ? deadlineIso : null);
    setSheetKey((k) => k + 1);
    setOpen(true);
  };

  const draftDate = fromIso(draft);
  const draftValid = draftDate !== null && now !== null && validateDeadline(draftDate, now) === "ok";

  const save = () => {
    if (!draft || !draftDate || validateDeadline(draftDate, new Date()) !== "ok") return;
    setOpen(false);
    onSave(draft);
  };

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex min-h-11 min-w-0 flex-wrap items-center gap-x-3" data-testid="lobby-deadline" aria-busy={pending || undefined}>
        <DeadlineSummary deadlineIso={deadlineIso} passedText="Passed" className="min-w-0 text-xl leading-7 data-[tier=passed]:text-danger" />
        {isHost ? (
          <button
            type="button"
            onClick={openSheet}
            data-testid="lobby-deadline-change"
            aria-label="Change when the game ends"
            className="-ml-2 inline-flex min-h-11 min-w-11 items-center gap-1.5 px-2 text-lg text-ink-soft underline decoration-ink-faint decoration-2 underline-offset-4 focus-visible:outline-2 focus-visible:outline-ink"
          >
            <Pencil aria-hidden className="size-4" strokeWidth={2.25} />
            Change
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-lg leading-7 text-danger" data-testid="lobby-deadline-error">
          {error}
        </p>
      ) : null}

      <Sheet open={open} onClose={() => setOpen(false)} title="Game ends" testId="deadline-sheet">
        <div className="flex min-w-0 flex-col gap-[14px] pb-2">
          <p id={headingId} className="text-lg leading-7 text-ink-soft">
            Everyone&apos;s game ends at this time, 10 minutes to 7 days from now.
          </p>
          <DeadlinePicker key={sheetKey} value={draft} onChange={onDraft} labelledBy={headingId} />
          <PencilButton onClick={save} disabled={!draftValid} className="w-full" data-testid="deadline-save">
            Save
          </PencilButton>
        </div>
      </Sheet>
    </div>
  );
}
