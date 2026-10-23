/**
 * Client-side pre-validation using the same limits as the RPCs
 * (CLAUDE.md > Database API > Input rules). The RPCs remain the authority.
 */

/** Collapse whitespace runs to one space and trim, as the DB does for single-line fields. */
export function normalizeSingleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export const GAME_NAME_MAX = 60;
export const DISPLAY_NAME_MAX = 24;
export const LABEL_MAX = 40;
export const DETAILS_MAX = 200;

export function isValidGameName(value: string): boolean {
  const n = normalizeSingleLine(value).length;
  return n >= 1 && n <= GAME_NAME_MAX;
}

export function isValidDisplayName(value: string): boolean {
  const n = normalizeSingleLine(value).length;
  return n >= 1 && n <= DISPLAY_NAME_MAX;
}
