"use client";

import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { PencilButton } from "@/components/ui/PencilButton";
import { describeDeadline } from "@/lib/deadline/format";
import {
  EXTEND_QUICK,
  extendBy,
  extendInputBounds,
  validateExtension,
  type ExtendChoice,
  type ExtensionValidity,
} from "@/lib/deadline/extend";
import { fromIso, localInputValue, parseLocalInput, resolveTimeZone, toIso } from "@/lib/deadline/presets";
import { useNow } from "@/lib/deadline/useNow";

const OPTIONS: { value: ExtendChoice; label: string }[] = [
  ...EXTEND_QUICK.map((q) => ({ value: q.choice, label: q.label })),
  { value: "custom", label: "Custom" },
];

const CUSTOM_MESSAGES: Record<ExtensionValidity | "empty", string> = {
  ok: "Up to 24 hours after the current deadline",
  too_soon: "Later than the current deadline",
  too_far: "No more than 24 hours after the current deadline",
  empty: "Pick a date and time",
};

export type ExtendDeadlineFormProps = {
  /** The game's current `deadline_at`. */
  currentIso: string;
  /** Called with the new deadline (ISO) when the host taps Save. */
  onSave: (nextIso: string) => void;
  /** Copy for the last failed attempt, shown inline. */
  error?: string | null;
  /** The choice to start on (a retry after an error keeps what was picked). */
  initialIso?: string | null;
  /** IANA zone for text and the custom input. Default: the phone's zone. */
  timeZone?: string;
};

/**
 * The host's single live extension: "+1 hour", "+3 hours", "+24 hours" (each
 * clipped to current + 24 h) or a custom time between 1 minute and 24 hours
 * after the current deadline, then Save. Nothing is sent before Save. The
 * `extend_deadline` RPC enforces host-only, live-only, once and the 1-day cap.
 */
export function ExtendDeadlineForm({ currentIso, onSave, error = null, initialIso = null, timeZone }: ExtendDeadlineFormProps) {
  const baseId = `extend${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const zone = useMemo(() => resolveTimeZone(timeZone), [timeZone]);
  const now = useNow(30_000);
  const current = fromIso(currentIso);
  const initial = fromIso(initialIso);
  const [choice, setChoice] = useState<ExtendChoice>(() => {
    if (!current || !initial) return "1h";
    const quick = EXTEND_QUICK.find((q) => extendBy(current, q.ms).getTime() === initial.getTime());
    return quick?.choice ?? "custom";
  });
  const [customText, setCustomText] = useState(() =>
    current ? localInputValue(initial ?? extendBy(current, EXTEND_QUICK[0].ms), zone) : "",
  );
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  if (!current) return null;

  const quick = EXTEND_QUICK.find((q) => q.choice === choice);
  const candidate = quick ? extendBy(current, quick.ms) : parseLocalInput(customText, zone);
  const validity: ExtensionValidity | "empty" = candidate ? validateExtension(current, candidate) : "empty";
  const bounds = extendInputBounds(current, zone);
  const describe = (date: Date) => (now ? describeDeadline(date, now, zone) : "");

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    const back = event.key === "ArrowLeft" || event.key === "ArrowUp";
    if (!forward && !back) return;
    event.preventDefault();
    const next = (index + (forward ? 1 : -1) + OPTIONS.length) % OPTIONS.length;
    setChoice(OPTIONS[next].value);
    refs.current[next]?.focus();
  };

  const inputId = `${baseId}-custom-input`;
  const messageId = `${baseId}-custom-message`;
  const customLabelId = `${baseId}-custom-label`;

  return (
    <div className="flex min-w-0 flex-col gap-[14px] pb-2" data-testid="extend-form">
      <p className="text-lg leading-7 text-ink-soft" data-testid="extend-current">
        Now ends {describe(current)}. You can extend it once, by up to 24 hours.
      </p>
      <div role="radiogroup" aria-label="New deadline" className="flex min-w-0 flex-col gap-2" data-selected={choice}>
        {OPTIONS.map((option, index) => {
          const checked = option.value === choice;
          const q = EXTEND_QUICK.find((x) => x.choice === option.value);
          const resolved = q
            ? describe(extendBy(current, q.ms))
            : checked && candidate && validity === "ok"
              ? describe(candidate)
              : "Pick a time";
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
              onClick={() => setChoice(option.value)}
              onKeyDown={(event) => onKeyDown(event, index)}
              data-testid={`extend-option-${option.value}`}
              className={`flex min-h-12 w-full min-w-0 flex-wrap items-baseline justify-between gap-x-3 px-3 py-2 text-left text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
                checked ? "pencil-border bg-highlight shadow-[2px_2px_0_var(--ink)]" : "pencil-border-alt bg-paper"
              }`}
            >
              <span
                id={option.value === "custom" ? customLabelId : undefined}
                className="min-w-0 flex-[1_1_7rem] text-xl leading-7 break-words"
              >
                {option.label}
              </span>
              <span className="ml-auto min-h-6 shrink-0 text-base leading-6 whitespace-nowrap text-ink-soft">{resolved}</span>
            </button>
          );
        })}
      </div>
      {choice === "custom" ? (
        <div className="flex min-w-0 flex-col px-1">
          <input
            id={inputId}
            type="datetime-local"
            value={customText}
            min={bounds.min}
            max={bounds.max}
            onChange={(event) => setCustomText(event.target.value)}
            aria-labelledby={customLabelId}
            aria-describedby={messageId}
            aria-invalid={validity !== "ok" || undefined}
            data-testid="extend-custom-input"
            className="min-h-11 w-full min-w-0 max-w-full border-0 border-b-2 border-ink bg-transparent px-1 text-base text-ink outline-none focus:border-b-[3px]"
          />
          <p
            id={messageId}
            aria-live="polite"
            data-state={validity}
            className={`text-base leading-7 ${validity === "ok" ? "text-ink-soft" : "text-danger"}`}
          >
            {CUSTOM_MESSAGES[validity]}
          </p>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-lg leading-7 text-danger" data-testid="extend-error">
          {error}
        </p>
      ) : null}
      <PencilButton
        onClick={() => {
          if (candidate && validity === "ok") onSave(toIso(candidate));
        }}
        disabled={validity !== "ok"}
        className="w-full"
        data-testid="extend-save"
      >
        Save
      </PencilButton>
    </div>
  );
}
