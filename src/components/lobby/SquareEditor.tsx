"use client";

import { useId, useState, type FormEvent, type RefObject } from "react";
import { PencilButton } from "@/components/ui/PencilButton";
import { Toggle } from "@/components/ui/Toggle";
import { isNewerSquare } from "@/lib/game/realtime";
import type { Square } from "@/lib/game/types";
import { DETAILS_MAX, LABEL_MAX } from "@/lib/game/validation";
import {
  COUNTER_MAX,
  COUNTER_MIN,
  fieldsOf,
  parseTarget,
  sameFields,
  toSquareInput,
  type SquareFields,
} from "@/components/lobby/squareFields";

type Props = {
  /** The latest server row for this square (live: events and resyncs update it). */
  square: Square | undefined;
  /** Unsaved typing to restore (after a failed save). */
  draft?: SquareFields;
  error?: string;
  labelRef: RefObject<HTMLInputElement | null>;
  onSave: (fields: SquareFields) => void;
  onCancel: () => void;
};

type Incoming = { fields: SquareFields; stamp: string };

/**
 * Edit form for one square. If someone else saves this square while the form
 * is open: untouched fields refresh with a note; unsaved typing is kept and
 * the player is asked before it is replaced.
 */
export function SquareEditor({ square, draft, error, labelRef, onSave, onCancel }: Props) {
  const ids = { label: useId(), details: useId(), target: useId(), counter: useId() };
  const [base, setBase] = useState<SquareFields>(() => fieldsOf(square));
  const [form, setForm] = useState<SquareFields>(() => draft ?? fieldsOf(square));
  const [seenStamp, setSeenStamp] = useState(square?.updated_at ?? "");
  const [conflict, setConflict] = useState<Incoming | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // A newer version of this square arrived (adjusting state during render,
  // so the form never shows a stale frame).
  if (square && square.updated_at !== seenStamp) {
    setSeenStamp(square.updated_at);
    if (isNewerSquare(square, { updated_at: seenStamp })) {
      const incoming = fieldsOf(square);
      if (sameFields(form, base) || sameFields(form, incoming)) {
        setForm(incoming);
        setBase(incoming);
        setConflict(null);
        if (!sameFields(incoming, base)) setNotice("Updated by someone else.");
      } else {
        setConflict({ fields: incoming, stamp: square.updated_at });
      }
    }
  }

  const set = (patch: Partial<SquareFields>) => {
    setNotice(null);
    setForm((f) => ({ ...f, ...patch }));
  };

  const input = toSquareInput(form);
  const targetInvalid = form.isCounter && parseTarget(form.target) === null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!input) return;
    if (sameFields(form, base) && !draft) {
      onCancel();
      return;
    }
    onSave(form);
  };

  const useTheirs = () => {
    if (!conflict) return;
    setForm(conflict.fields);
    setBase(conflict.fields);
    setConflict(null);
  };
  const keepMine = () => {
    if (!conflict) return;
    setBase(conflict.fields);
    setConflict(null);
  };

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-[14px] pb-2" data-testid="square-editor" noValidate>
      {conflict ? (
        <div role="status" data-testid="square-conflict" className="index-card flex min-w-0 flex-col gap-1 px-3 pb-2 pt-1.5">
          <p className="text-xl leading-7">Updated by someone else.</p>
          <p className="text-base leading-[22px] text-ink-soft break-words">
            Now: “{conflict.fields.label || "empty"}”. Keep your changes or use theirs?
          </p>
          <div className="flex flex-wrap gap-2">
            <PencilButton variant="secondary" onClick={keepMine} data-testid="conflict-keep">
              Keep mine
            </PencilButton>
            <PencilButton variant="quiet" onClick={useTheirs} data-testid="conflict-theirs">
              Use theirs
            </PencilButton>
          </div>
        </div>
      ) : notice ? (
        <p role="status" data-testid="square-notice" className="text-lg leading-7 text-ink-soft">
          {notice}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-lg leading-7 text-danger" data-testid="square-error">
          {error}
        </p>
      ) : null}

      <div className="flex min-w-0 flex-col">
        <label htmlFor={ids.label} className="text-lg leading-7 text-ink-soft">
          Square text
        </label>
        <input
          ref={labelRef}
          id={ids.label}
          value={form.label}
          onChange={(e) => set({ label: e.target.value })}
          maxLength={LABEL_MAX}
          autoComplete="off"
          enterKeyHint="done"
          placeholder="e.g. Skyline Chili"
          data-testid="square-label"
          className="min-h-11 w-full min-w-0 border-0 border-b-2 border-ink bg-transparent px-1 text-2xl text-ink outline-none placeholder:text-ink-faint focus:border-b-[3px]"
        />
        <span className="self-end text-base leading-7 text-ink-soft" aria-live="polite" data-testid="label-remaining">
          {LABEL_MAX - form.label.length} left
        </span>
      </div>

      <div className="flex min-w-0 flex-col">
        <label htmlFor={ids.details} className="text-lg leading-7 text-ink-soft">
          Details <span className="text-base">(optional, shown when someone opens the square)</span>
        </label>
        <textarea
          id={ids.details}
          value={form.details}
          onChange={(e) => set({ details: e.target.value })}
          maxLength={DETAILS_MAX}
          rows={3}
          data-testid="square-details"
          className="w-full min-w-0 resize-none border-2 border-ink-soft bg-transparent px-2 py-1 text-xl leading-7 text-ink outline-none [border-radius:6px_3px_7px_4px] focus:border-ink"
        />
        <span className="self-end text-base leading-7 text-ink-soft">{DETAILS_MAX - form.details.length} left</span>
      </div>

      <Toggle
        checked={form.isCounter}
        onChange={(isCounter) => set({ isCounter })}
        label="Counter square"
        description="Done after a number of tries, like 15 signatures."
        testId="counter-toggle"
      />
      {form.isCounter ? (
        <div className="flex min-w-0 items-end gap-3">
          <div className="flex flex-col">
            <label htmlFor={ids.target} className="text-lg leading-7 text-ink-soft">
              How many?
            </label>
            <input
              id={ids.target}
              value={form.target}
              onChange={(e) => set({ target: e.target.value.replace(/[^0-9]/g, "").slice(0, 2) })}
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              aria-invalid={targetInvalid || undefined}
              aria-describedby={ids.counter}
              data-testid="counter-target"
              className="min-h-11 w-20 border-0 border-b-2 border-ink bg-transparent px-1 text-2xl text-ink outline-none focus:border-b-[3px]"
            />
          </div>
          <span id={ids.counter} className={`pb-2 text-base ${targetInvalid ? "text-danger" : "text-ink-soft"}`}>
            {COUNTER_MIN}–{COUNTER_MAX}
          </span>
        </div>
      ) : null}

      <div className="mt-1 flex items-center gap-3">
        <PencilButton type="submit" disabled={!input} className="flex-1 text-2xl" data-testid="square-save">
          Save
        </PencilButton>
        <PencilButton variant="quiet" onClick={onCancel}>
          Cancel
        </PencilButton>
      </div>
    </form>
  );
}
