/**
 * Copy for invite-link previews (Open Graph / Twitter tags and the card image at
 * /g/[code]/opengraph-image). Pure: no network, no React, so it is unit-tested and shared by
 * `generateMetadata` and the image route.
 */

import type { GamePreview } from "@/lib/game/types";

export const SITE_NAME = "Bingo Night";

/** What `peek_game_public` returns: the effective status and a head count, nothing personal. */
export type InvitePreview = GamePreview;

export type PreviewCopy = {
  /** `<title>`, og:title, twitter:title. */
  title: string;
  /** description, og:description, twitter:description. */
  description: string;
  /** Large game name on the card (clamped), or null for the generic card. */
  heading: string | null;
  /** The line under the heading on the card. */
  subline: string;
};

/** Longest game name shown on the card before it is cut with an ellipsis (two lines). */
export const HEADING_MAX_CHARS = 40;

const JOIN_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

/**
 * Whether a normalized code could be a join code (8 chars from the DB's alphabet). Anything
 * else cannot match a game, so previews skip the lookup and show the generic card.
 */
export function isPlausibleJoinCode(code: string): boolean {
  return JOIN_CODE.test(code);
}

/** "ABCDEFGH" → "ABCD EFGH" (easier to read off a card); other lengths unchanged. */
export function groupJoinCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}

/** Collapses whitespace and cuts names over `max` chars at a word edge when possible, adding "…". */
export function clampGameName(name: string, max = HEADING_MAX_CHARS): string {
  const clean = name.replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;
  const cut = chars.slice(0, max - 1).join("");
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace >= max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base.replace(/[\s.,;:!?·-]+$/, "")}…`;
}

/** "1 player in" / "4 players in". */
export function playersIn(count: number): string {
  return `${count} ${count === 1 ? "player" : "players"} in`;
}

/** Card heading size in px so a clamped name fits two lines of the card's text column. */
export function headingFontSize(heading: string): number {
  const length = Array.from(heading).length;
  if (length <= 12) return 92;
  if (length <= 20) return 80;
  if (length <= 28) return 64;
  return 52;
}

/** Narrows whatever the public RPC answered to a preview, or null if it is not one. */
export function asInvitePreview(value: unknown): InvitePreview | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return null;
  const { name, status, player_count, free_center } = row as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "") return null;
  if (status !== "lobby" && status !== "active" && status !== "ended") return null;
  const count = typeof player_count === "number" && Number.isFinite(player_count) ? Math.max(0, Math.trunc(player_count)) : 0;
  return { name, status, player_count: count, free_center: free_center !== false };
}

/** Title, description and card lines for a game preview, or the generic copy when null. */
export function previewCopy(preview: InvitePreview | null): PreviewCopy {
  if (!preview) {
    return {
      title: `Join the game · ${SITE_NAME}`,
      description: "Tap to join the board — no signup.",
      heading: null,
      subline: "Tap to join · no signup",
    };
  }
  const name = preview.name.replace(/\s+/g, " ").trim();
  const heading = clampGameName(name);
  if (preview.status === "ended") {
    return {
      title: `${name} · ${SITE_NAME}`,
      description: "This game has ended.",
      heading,
      subline: "This game has ended",
    };
  }
  if (preview.player_count < 1) {
    return {
      title: `Join ${name} · ${SITE_NAME}`,
      description: "Tap to join the board — no signup.",
      heading,
      subline: "Tap to join · no signup",
    };
  }
  return {
    title: `Join ${name} · ${SITE_NAME}`,
    description: `${playersIn(preview.player_count)}. Tap to join the board — no signup.`,
    heading,
    subline: `${playersIn(preview.player_count)} · Tap to join`,
  };
}
