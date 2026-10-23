"use client";

import { useId, type ReactNode } from "react";

type Props = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  busy?: boolean;
  testId?: string;
  className?: string;
};

/** A pencil-drawn on/off switch with its label; the whole row is the tap target (≥44px). */
export function Toggle({ checked, onChange, label, description, disabled, busy, testId, className }: Props) {
  const labelId = useId();
  const descId = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      aria-describedby={description ? descId : undefined}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      data-testid={testId}
      data-checked={checked}
      className={`flex min-h-11 w-full min-w-0 items-center gap-3 py-1 text-left text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-45 ${className ?? ""}`}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span id={labelId} className="text-xl leading-7">
          {label}
        </span>
        {description ? (
          <span id={descId} className="text-base leading-[22px] text-ink-soft">
            {description}
          </span>
        ) : null}
      </span>
      <span
        aria-hidden
        className={`pencil-border relative inline-flex h-8 w-14 shrink-0 items-center transition-colors duration-150 ${
          checked ? "bg-highlight" : "bg-paper"
        }`}
      >
        <span
          className={`absolute top-1/2 size-5 -translate-y-1/2 rounded-[48%_52%_45%_55%/55%_45%_52%_48%] border-2 border-ink transition-[left] duration-150 ${
            checked ? "left-[calc(100%-1.6rem)] bg-ink" : "left-1 bg-paper"
          }`}
        />
      </span>
    </button>
  );
}
