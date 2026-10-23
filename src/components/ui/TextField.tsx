"use client";

import { useId, type InputHTMLAttributes } from "react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> & {
  label: string;
  value: string;
  onChange: (value: string) => void;
  max: number;
  hint?: string;
};

/** A pencil-underlined text input with a label and a quiet character counter. */
export function TextField({ label, value, onChange, max, hint, className, ...rest }: Props) {
  const id = useId();
  const length = value.length;
  return (
    <div className={`flex min-w-0 flex-col ${className ?? ""}`}>
      <label htmlFor={id} className="text-lg leading-7 text-ink-soft">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={max}
        autoComplete="off"
        className="min-h-11 w-full min-w-0 border-0 border-b-2 border-ink bg-transparent px-1 text-2xl text-ink outline-none placeholder:text-ink-faint focus:border-b-[3px]"
        {...rest}
      />
      <div className="flex justify-between gap-2 text-base leading-7 text-ink-soft">
        <span>{hint}</span>
        <span className={length > max ? "text-danger" : undefined} aria-live="polite">
          {length > max - 10 ? `${length}/${max}` : ""}
        </span>
      </div>
    </div>
  );
}
