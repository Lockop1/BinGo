"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useId, useRef, useState, type FormEvent } from "react";
import { PackPicker } from "@/components/create/PackPicker";
import { DeadlinePicker, DeadlineSummary } from "@/components/deadline/DeadlinePicker";
import { PencilButton } from "@/components/ui/PencilButton";
import { TextField } from "@/components/ui/TextField";
import { getPack, packToSquares, type PackId } from "@/content/packs";
import { track } from "@/lib/analytics";
import { errorCopy } from "@/lib/game/errors";
import { createGame } from "@/lib/game/rpc";
import { deadlineBlockMessage, tooSoonFromMs } from "@/lib/deadline/drift";
import { fromIso, validateDeadline, type DeadlinePreset } from "@/lib/deadline/presets";
import { useNowUntil } from "@/lib/deadline/useNow";
import {
  DISPLAY_NAME_MAX,
  GAME_NAME_MAX,
  isValidDisplayName,
  isValidGameName,
  normalizeSingleLine,
} from "@/lib/game/validation";
import { saveDisplayName } from "@/lib/storage/local";
import { useStoredDisplayName } from "@/lib/storage/useStoredDisplayName";

export function CreateGameForm() {
  const router = useRouter();
  const storedName = useStoredDisplayName();
  const [name, setName] = useState("");
  const [packId, setPackId] = useState<PackId>("night-out");
  const [freeCenter, setFreeCenter] = useState(true);
  // null = untouched, so the saved name can prefill after hydration.
  const [hostDraft, setHostDraft] = useState<string | null>(null);
  const hostName = hostDraft ?? storedName;
  // Filled by the picker right after mount (Tonight), so the default needs no tap.
  const [deadlineIso, setDeadlineIso] = useState<string | null>(null);
  const [deadlinePreset, setDeadlinePreset] = useState<DeadlinePreset | null>(null);
  // When the picker produced the value: validity is never judged on a clock
  // reading older than that (a 7-day clamp would read as "too far").
  const [deadlineSetAt, setDeadlineSetAt] = useState(0);
  const onDeadline = useCallback((iso: string, preset: DeadlinePreset) => {
    setDeadlineIso(iso);
    setDeadlinePreset(preset);
    setDeadlineSetAt(Date.now());
  }, []);
  const deadlineHeadingId = useId();
  const deadline = fromIso(deadlineIso);
  // Wakes at the same moment as the picker's clock when the value crosses the
  // 10-minute minimum, so Create never waits on a stale reading.
  const now = useNowUntil(15_000, deadline ? tooSoonFromMs(deadline) : null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);

  const checkAt = now ? new Date(Math.max(now.getTime(), deadlineSetAt)) : null;
  const deadlineValidity = deadline && checkAt ? validateDeadline(deadline, checkAt) : null;
  const deadlineValid = deadlineValidity === "ok";
  // A preset re-resolves itself (and says so); a Custom time's own line says
  // what is wrong. Anything else that keeps Create disabled is explained here.
  const deadlineMessage = deadlinePreset === "custom" ? null : deadlineBlockMessage(deadlineValidity);
  const valid = isValidGameName(name) && isValidDisplayName(hostName) && deadlineValid;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!valid || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    const host = normalizeSingleLine(hostName);
    try {
      const game = await createGame({
        name: normalizeSingleLine(name),
        host_name: host,
        free_center: freeCenter,
        squares: packToSquares(getPack(packId)),
        deadlineAt: deadlineIso,
      });
      saveDisplayName(host);
      track("game_created", { pack: packId, free_center: freeCenter });
      // Stay "submitting" while the next screen loads so a second tap does nothing.
      router.replace(`/game/${game.id}`);
    } catch (err) {
      submitting.current = false;
      setBusy(false);
      setError(errorCopy(err));
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex min-w-0 flex-col gap-5" noValidate>
      <TextField
        label="Game name"
        value={name}
        onChange={setName}
        max={GAME_NAME_MAX}
        placeholder="Friday on Main St"
        enterKeyHint="next"
        data-testid="game-name"
        required
      />

      <PackPicker value={packId} onChange={setPackId} />

      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-xl">
        <input
          type="checkbox"
          checked={freeCenter}
          onChange={(e) => setFreeCenter(e.target.checked)}
          className="peer sr-only"
          data-testid="free-center"
        />
        <span
          aria-hidden
          className="flex size-7 shrink-0 items-center justify-center pencil-border-alt peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink"
        >
          {freeCenter ? <Check className="size-5" strokeWidth={3} /> : null}
        </span>
        Free space in the middle
      </label>

      <section className="flex min-w-0 flex-col gap-1" aria-labelledby={deadlineHeadingId} data-testid="create-deadline">
        <h2 id={deadlineHeadingId} className="text-lg leading-7 text-ink-soft">
          Game ends
        </h2>
        <DeadlinePicker value={deadlineIso} onChange={onDeadline} labelledBy={deadlineHeadingId} disabled={busy} />
        <p className="min-h-7 text-lg leading-7" data-testid="create-deadline-summary">
          <DeadlineSummary deadlineIso={deadlineIso} />
        </p>
        {deadlineMessage ? (
          <p role="status" className="text-lg leading-7 text-danger" data-testid="create-deadline-problem">
            {deadlineMessage}
          </p>
        ) : null}
      </section>

      <TextField
        label="Your name"
        value={hostName}
        onChange={setHostDraft}
        max={DISPLAY_NAME_MAX}
        placeholder="What friends call you"
        autoCapitalize="words"
        enterKeyHint="go"
        data-testid="host-name"
        required
      />

      {error ? (
        <p role="alert" className="text-lg leading-7 text-danger">
          {error}
        </p>
      ) : null}

      <PencilButton type="submit" disabled={!valid} busy={busy} className="w-full text-2xl" data-testid="create-game">
        {busy ? "Creating…" : "Create game"}
      </PencilButton>
    </form>
  );
}
