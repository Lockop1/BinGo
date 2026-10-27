"use client";

import { useId, type InputHTMLAttributes, type ReactNode } from "react";

type Props = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "value" | "autoCapitalize" | "autoCorrect" | "autoComplete" | "spellCheck" | "inputMode"
> & {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Sits right of the input on the same pencil line (e.g. the Join button). */
  action?: ReactNode;
};

/**
 * A join-code field in the same pencil-underlined style as `TextField`: no
 * autocapitalize / autocorrect / spellcheck (codes are not words), shown in
 * capitals, at least 16 px so iOS never zooms in. Accepts what people type or
 * paste (`abcd-efgh`, `abcd efgh`, the invite link); normalise the value with
 * `codeFromInput` before using it.
 */
export function JoinCodeInput({ label, value, onChange, action, className, ...rest }: Props) {
  const id = useId();
  return (
    <div className={`flex min-w-0 flex-col ${className ?? ""}`}>
      <label htmlFor={id} className="text-lg leading-7 text-ink-soft">
        {label}
      </label>
      <div className="flex min-w-0 items-end gap-3">
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          type="text"
          inputMode="text"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          maxLength={200}
          className="min-h-11 w-full min-w-0 flex-1 border-0 border-b-2 border-ink bg-transparent px-1 text-2xl tracking-[0.08em] text-ink uppercase outline-none placeholder:text-ink-faint focus:border-b-[3px]"
          {...rest}
        />
        {action}
      </div>
    </div>
  );
}
