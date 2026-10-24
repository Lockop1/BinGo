"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { PackPicker } from "@/components/create/PackPicker";
import { PencilButton } from "@/components/ui/PencilButton";
import { TextField } from "@/components/ui/TextField";
import { getPack, packToSquares, type PackId } from "@/content/packs";
import { track } from "@/lib/analytics";
import { errorCopy } from "@/lib/game/errors";
import { createGame } from "@/lib/game/rpc";
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

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);

  const valid = isValidGameName(name) && isValidDisplayName(hostName);

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
