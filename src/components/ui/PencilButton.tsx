"use client";

import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps, ReactNode, Ref } from "react";

type Variant = "primary" | "secondary" | "quiet";

const BASE =
  "inline-flex min-h-11 select-none items-center justify-center gap-2 px-5 py-2 text-xl leading-tight " +
  "text-ink transition-transform duration-75 focus-visible:outline-2 focus-visible:outline-offset-2 " +
  "focus-visible:outline-ink active:translate-y-px active:scale-[0.98] " +
  "disabled:cursor-not-allowed disabled:opacity-45 disabled:active:translate-y-0 disabled:active:scale-100";

const VARIANTS: Record<Variant, string> = {
  primary: "pencil-border bg-highlight shadow-[2px_3px_0_var(--ink)] active:shadow-[1px_1px_0_var(--ink)]",
  secondary: "pencil-border-alt bg-paper",
  quiet: "underline decoration-ink-faint decoration-2 underline-offset-4 px-2",
};

export function pencilButtonClass(variant: Variant = "primary", className = ""): string {
  return `${BASE} ${VARIANTS[variant]} ${className}`.trim();
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: Ref<HTMLButtonElement>;
  variant?: Variant;
  /** Shows the pressed/working state and blocks clicks without changing layout. */
  busy?: boolean;
  children: ReactNode;
};

export function PencilButton({ variant = "primary", busy = false, className, disabled, children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={pencilButtonClass(variant, `${busy ? "translate-y-px scale-[0.98]" : ""} ${className ?? ""}`)}
    >
      {children}
    </button>
  );
}

type LinkProps = ComponentProps<typeof Link> & { variant?: Variant };

export function PencilLink({ variant = "primary", className, ...rest }: LinkProps) {
  return <Link {...rest} className={pencilButtonClass(variant, className ?? "")} />;
}
