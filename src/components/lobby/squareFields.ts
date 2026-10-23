import { DETAILS_MAX, LABEL_MAX, normalizeSingleLine } from "@/lib/game/validation";
import type { Square } from "@/lib/game/types";

/** The editable part of a square as the sheet's form holds it. */
export type SquareFields = {
  label: string;
  details: string;
  isCounter: boolean;
  /** Raw input text for the counter target. */
  target: string;
};

export const COUNTER_MIN = 2;
export const COUNTER_MAX = 99;
const DEFAULT_TARGET = "10";

export function fieldsOf(square: Pick<Square, "label" | "details" | "target_count"> | undefined): SquareFields {
  const target = square?.target_count ?? 1;
  return {
    label: square?.label ?? "",
    details: square?.details ?? "",
    isCounter: target > 1,
    target: target > 1 ? String(target) : DEFAULT_TARGET,
  };
}

export function parseTarget(raw: string): number | null {
  if (!/^\d{1,2}$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= COUNTER_MIN && n <= COUNTER_MAX ? n : null;
}

/** What update_square receives (normalized the way the RPC normalizes), or null if invalid. */
export function toSquareInput(fields: SquareFields): { label: string; details: string; target_count: number } | null {
  const label = normalizeSingleLine(fields.label);
  const details = fields.details.trim();
  if (label.length > LABEL_MAX || details.length > DETAILS_MAX) return null;
  const target = fields.isCounter ? parseTarget(fields.target) : 1;
  if (target === null) return null;
  return { label, details, target_count: target };
}

/** Same content after normalization (so whitespace-only typing is not "unsaved changes"). */
export function sameFields(a: SquareFields, b: SquareFields): boolean {
  const x = toSquareInput(a);
  const y = toSquareInput(b);
  if (!x || !y) return a.label === b.label && a.details === b.details && a.isCounter === b.isCounter && a.target === b.target;
  return x.label === y.label && x.details === y.details && x.target_count === y.target_count;
}
