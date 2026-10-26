"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { countdown, deadlineSummaryText, describeDeadline, isUnderOneHour } from "@/lib/deadline/format";
import {
  DEFAULT_DEADLINE_PRESET,
  computePreset,
  customInputBounds,
  fromIso,
  localInputValue,
  matchPreset,
  parseLocalInput,
  resolveTimeZone,
  toIso,
  validateDeadline,
  type DeadlinePreset,
} from "@/lib/deadline/presets";
import { useCountdown, useHydrated, useNow } from "@/lib/deadline/useNow";

const OPTIONS: { value: DeadlinePreset; label: string }[] = [
  { value: "tonight", label: "Tonight (3 AM)" },
  { value: "day", label: "24 hours" },
  { value: "weekend", label: "This weekend (Sunday 11:59 PM)" },
  { value: "custom", label: "Custom" },
];

const CUSTOM_MESSAGES = {
  ok: "Any time up to 7 days from now",
  too_soon: "At least 10 minutes from now",
  too_far: "No more than 7 days out",
  empty: "Pick a date and time",
} as const;

export type DeadlinePickerProps = {
  /** The deadline as an ISO string, or `null` before the form has one. */
  value: string | null;
  /** Called with the new deadline and which row produced it. */
  onChange: (nextIso: string, preset: DeadlinePreset) => void;
  /** Fixed "now" (tests, previews). Default: the live clock, refreshed every minute. */
  now?: Date;
  /** IANA zone for presets and text. Default: the phone's zone. */
  timeZone?: string;
  disabled?: boolean;
  /** Prefix for element ids (default: a `useId` value). */
  idPrefix?: string;
  /** Id of the visible heading that names the group (else it is labelled "Game ends"). */
  labelledBy?: string;
};

/**
 * Pencil-on-paper radio group for the game deadline: Tonight (3 AM), 24 hours,
 * This weekend (Sunday 11:59 PM) and Custom, each showing the time it resolves
 * to on the right (the selected row shows the actual `value`).
 *
 * Behaviour:
 * - Picking a preset calls `onChange` at once with the time it gives now.
 *   Picking Custom calls `onChange(value, "custom")` with the current value (or
 *   Tonight's when that is no longer valid) and shows a `datetime-local` input
 *   (min 10 minutes / max 7 days out, in the picker's zone). Typing only calls
 *   `onChange` for a valid time, so the form keeps the last valid value while
 *   the inline line says what is wrong.
 * - When `value` is `null`, the picker selects Tonight and calls `onChange`
 *   once after mount, so the form always has a deadline to submit. Likewise, if
 *   a selected preset's value drifts under 10 minutes away (the screen was left
 *   open), it is re-resolved and `onChange` fires with the fresh time. Neither
 *   happens while `disabled`.
 * - With an initial `value`, the row it matches (`matchPreset`) is selected,
 *   else Custom.
 * - Hydration: all time-dependent text (and the custom input) renders only
 *   after mount; the server HTML shows the four rows with empty time slots.
 */
export function DeadlinePicker({
  value,
  onChange,
  now: nowProp,
  timeZone,
  disabled = false,
  idPrefix,
  labelledBy,
}: DeadlinePickerProps) {
  const autoId = useId();
  const baseId = idPrefix ?? `deadline${autoId.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const hydrated = useHydrated();
  const liveNow = useNow(60_000);
  const now = hydrated ? (nowProp ?? liveNow) : null;
  const zone = useMemo(() => resolveTimeZone(timeZone), [timeZone]);
  const current = fromIso(value);

  // The row the person (or the initial value) chose; null until time is known.
  const [choice, setChoice] = useState<DeadlinePreset | null>(null);
  const [customText, setCustomText] = useState("");
  const [seenValue, setSeenValue] = useState(value);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const lastAuto = useRef<string | null>(null);

  // Adjust state while rendering (React's "storing information from previous
  // renders" pattern) instead of an effect, so there is no flash of the wrong row.
  if (choice === null && now) {
    setChoice(current ? matchPreset(current, now, zone) : DEFAULT_DEADLINE_PRESET);
    setCustomText(current ? localInputValue(current, zone) : "");
  }
  if (value !== seenValue) {
    setSeenValue(value);
    if (current) setCustomText(localInputValue(current, zone));
  }

  const selected: DeadlinePreset | null = choice ?? (value ? null : DEFAULT_DEADLINE_PRESET);

  // Fill in (or refresh) a preset's value; see "Behaviour" above.
  useEffect(() => {
    if (!now || disabled || selected === null || selected === "custom") return;
    const held = fromIso(value);
    if (held && validateDeadline(held, now) !== "too_soon") return;
    const next = toIso(computePreset(selected, now, zone));
    if (lastAuto.current === next) return;
    lastAuto.current = next;
    onChange(next, selected);
  }, [now, disabled, selected, value, zone, onChange]);

  const select = (preset: DeadlinePreset) => {
    if (disabled) return;
    setChoice(preset);
    if (!hydrated) return; // The effect above fills the value in after mount.
    const at = nowProp ?? new Date();
    if (preset === "custom") {
      const base = current && validateDeadline(current, at) === "ok" ? current : computePreset("tonight", at, zone);
      setCustomText(localInputValue(base, zone));
      onChange(toIso(base), "custom");
      return;
    }
    onChange(toIso(computePreset(preset, at, zone)), preset);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    const back = event.key === "ArrowLeft" || event.key === "ArrowUp";
    let next: number | null = null;
    if (forward || back) next = (index + (forward ? 1 : -1) + OPTIONS.length) % OPTIONS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = OPTIONS.length - 1;
    if (next === null) return;
    event.preventDefault();
    select(OPTIONS[next].value);
    refs.current[next]?.focus();
  };

  const onCustomInput = (text: string) => {
    setCustomText(text);
    const parsed = parseLocalInput(text, zone);
    if (!parsed || disabled) return;
    if (validateDeadline(parsed, nowProp ?? new Date()) === "ok") onChange(toIso(parsed), "custom");
  };

  const resolvedText = (preset: DeadlinePreset): string => {
    if (!now) return "";
    if (preset === selected && current) return describeDeadline(current, now, zone);
    if (preset === "custom") return "Pick a time";
    return describeDeadline(computePreset(preset, now, zone), now, zone);
  };

  const parsedCustom = parseLocalInput(customText, zone);
  const customState: keyof typeof CUSTOM_MESSAGES = !parsedCustom
    ? "empty"
    : now
      ? validateDeadline(parsedCustom, now)
      : "ok";
  const bounds = now ? customInputBounds(now, zone) : null;
  const inputId = `${baseId}-custom-input`;
  const messageId = `${baseId}-custom-message`;
  const customLabelId = `${baseId}-custom-label`;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        role="radiogroup"
        aria-label={labelledBy ? undefined : "Game ends"}
        aria-labelledby={labelledBy}
        aria-disabled={disabled || undefined}
        data-testid="deadline-picker"
        data-selected={selected ?? undefined}
        className="flex min-w-0 flex-col gap-2"
      >
        {OPTIONS.map((option, index) => {
          const checked = option.value === selected;
          const focusable = selected === null ? index === 0 : checked;
          return (
            <button
              key={option.value}
              ref={(node) => {
                refs.current[index] = node;
              }}
              id={`${baseId}-${option.value}`}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={focusable ? 0 : -1}
              disabled={disabled}
              onClick={() => select(option.value)}
              onKeyDown={(event) => onKeyDown(event, index)}
              data-testid={`deadline-option-${option.value}`}
              className={`flex min-h-12 w-full min-w-0 flex-wrap items-baseline justify-between gap-x-3 px-3 py-2 text-left text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-45 ${
                checked ? "pencil-border bg-highlight shadow-[2px_2px_0_var(--ink)]" : "pencil-border-alt bg-paper"
              }`}
            >
              <span
                id={option.value === "custom" ? customLabelId : undefined}
                className="min-w-0 flex-[1_1_9rem] text-xl leading-7 break-words"
              >
                {option.label}
              </span>
              <span
                data-testid="deadline-resolved"
                className="ml-auto min-h-6 shrink-0 text-base leading-6 whitespace-nowrap text-ink-soft"
              >
                {resolvedText(option.value)}
              </span>
            </button>
          );
        })}
      </div>
      {selected === "custom" && now && bounds ? (
        <div className="flex min-w-0 flex-col px-1">
          <input
            id={inputId}
            type="datetime-local"
            value={customText}
            min={bounds.min}
            max={bounds.max}
            disabled={disabled}
            onChange={(event) => onCustomInput(event.target.value)}
            aria-labelledby={customLabelId}
            aria-describedby={messageId}
            aria-invalid={customState !== "ok" || undefined}
            data-testid="deadline-custom-input"
            className="min-h-11 w-full min-w-0 max-w-full border-0 border-b-2 border-ink bg-transparent px-1 text-base text-ink outline-none focus:border-b-[3px] disabled:opacity-45"
          />
          <p
            id={messageId}
            aria-live="polite"
            data-testid="deadline-custom-message"
            data-state={customState}
            className={`text-base leading-7 ${customState === "ok" ? "text-ink-soft" : "text-danger"}`}
          >
            {CUSTOM_MESSAGES[customState]}
          </p>
        </div>
      ) : null}
    </div>
  );
}

export type DeadlineSummaryProps = {
  deadlineIso: string | null;
  /** Fixed "now" (tests, previews). Default: a countdown clock that ticks when the text changes. */
  now?: Date;
  timeZone?: string;
  className?: string;
  /** What the line says once the deadline has passed (default "Ended"; the lobby says "Passed"). */
  passedText?: string;
};

/**
 * One line, "Ends Sun 11:59 PM · 2d 4h" (`passedText`, "Ended", once passed), for the lobby
 * and the board. Renders nothing without a deadline, and an empty span until
 * mounted (hydration-safe). `data-tier` carries the countdown tier and
 * `data-urgent` is set under one hour, for styling by the caller.
 */
export function DeadlineSummary({
  deadlineIso,
  now: nowProp,
  timeZone,
  className,
  passedText = "Ended",
}: DeadlineSummaryProps) {
  const hydrated = useHydrated();
  const live = useCountdown(deadlineIso, timeZone);
  const zone = useMemo(() => resolveTimeZone(timeZone), [timeZone]);
  const deadline = fromIso(deadlineIso);
  if (!deadline) return null;
  const now = hydrated ? (nowProp ?? live.now) : null;
  const tier = now ? countdown(deadline, now).tier : undefined;
  const text = !now ? "" : tier === "passed" ? passedText : deadlineSummaryText(deadline, now, zone);
  return (
    <span
      data-testid="deadline-summary"
      data-tier={tier}
      data-urgent={now && isUnderOneHour(deadline, now) ? "true" : undefined}
      className={className}
    >
      {text}
    </span>
  );
}
