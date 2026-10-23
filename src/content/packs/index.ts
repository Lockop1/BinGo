import type { NewSquare } from "@/lib/game/rpc";
import { CENTER_POSITION } from "@/lib/game/types";

/**
 * Official starter packs. Content must stay app-store-safe: no drinking dares,
 * sexual content, illegal activity, trespassing or physical danger
 * (enforced in part by pack-content.test.ts).
 *
 * Layout convention: a pack lists exactly 24 squares (or none, for Blank).
 * They are placed in reading order around the center: positions 0–11, then
 * 13–24. Position 12 is never sent by a pack: with the free space on,
 * `start_game` labels it "FREE" and completes it; with it off, the center is
 * a blank square the group fills in the lobby.
 */

export type PackId = "night-out" | "day-adventure" | "blank";

export type PackSquare = {
  /** ≤40 chars; 2–4 words preferred. */
  label: string;
  /** Optional, ≤200 chars. */
  details?: string;
  /** Counter target (2–99); omitted = a normal square. */
  target_count?: number;
};

export type Pack = {
  id: PackId;
  name: string;
  tagline: string;
  squares: PackSquare[];
};

export const PACK_SQUARE_COUNT = 24;

const nightOut: Pack = {
  id: "night-out",
  name: "Night Out",
  tagline: "Social challenges and nerve tests.",
  squares: [
    { label: "Sing on stage at karaoke", details: "A full chorus at least. Duets count." },
    {
      label: "Bartender names a drink after us",
      details: "Get a bartender to name a drink after the group. Mocktails and sodas count.",
    },
    {
      label: "Collect 15 stranger signatures",
      details: "On a napkin, receipt or phone note. Ask nicely, take no for an answer.",
      target_count: 15,
    },
    { label: "Freestyle battle a stranger", details: "Rap, poetry or beatbox. Keep it friendly." },
    { label: "Dance battle with a stranger" },
    { label: "Stranger takes our group photo", details: "Everyone has to be in it." },
    { label: "Compliment a stranger's outfit", details: "Be specific and mean it." },
    {
      label: "Learn a stranger's life story",
      details: "Where they grew up, what they do, one surprising fact.",
    },
    { label: "Find a birthday-month twin", details: "Someone outside the group born in your month." },
    { label: "Group photo with a mascot or statue" },
    { label: "Order the weirdest thing on the menu", details: "Everyone has to try a bite." },
    { label: "Start a group sing-along", details: "At least three people outside the group join in." },
    { label: "Learn a dance move from a stranger" },
    {
      label: "Learn a phrase in a new language",
      details: "From someone who speaks it. Use it later tonight.",
    },
    { label: "Swap hats with a stranger", details: "For one photo, then swap back." },
    { label: "Get a table of strangers to cheer", details: "For anything: a birthday, a win, a great outfit." },
    { label: "Win a game of pool or darts" },
    { label: "Get the DJ to play our request" },
    { label: "Meet someone from another country" },
    { label: "Recreate a famous movie scene", details: "Someone outside the group has to guess the movie." },
    { label: "Invent a group handshake", details: "At least four moves. Everyone learns it." },
    { label: "Get a stranger's best advice" },
    { label: "Make a stranger laugh with a joke" },
    { label: "Air guitar solo on the dance floor" },
  ],
};

const dayAdventure: Pack = {
  id: "day-adventure",
  name: "Day Adventure",
  tagline: "Get outside and explore.",
  squares: [
    { label: "Find a hidden spot", details: "A quiet garden, courtyard or lookout that's open to the public." },
    {
      label: "Swim somewhere new",
      details: "A pool, lake or beach with a lifeguard or a marked swimming area.",
    },
    { label: "Watch the sunset together" },
    { label: "Try a food none of us have had" },
    { label: "Climb to a viewpoint", details: "Take a marked trail or public stairs up to a lookout." },
    { label: "Skip a stone 5 times", details: "Five bounces on one throw." },
    { label: "Find a little free library", details: "Take a book or leave one." },
    { label: "Photo with a mural" },
    { label: "Pet a dog (with permission)", details: "Always ask the owner first." },
    { label: "Spot 10 different birds", details: "Different kinds, not the same pigeon twice.", target_count: 10 },
    { label: "Have a picnic outside" },
    { label: "Find a heart-shaped rock" },
    { label: "Go for a group bike ride", details: "Helmets on, bike lanes where you can." },
    { label: "Visit a farmers' market", details: "Buy one thing nobody has tried before." },
    { label: "Watch a street performer", details: "Stay for the whole act." },
    { label: "Group jumping photo", details: "Everyone in the air at once." },
    { label: "Find the oldest building around" },
    { label: "Try a new ice cream flavor" },
    { label: "Spot an animal in the clouds" },
    { label: "Build a sandcastle" },
    { label: "Ask a local for their favorite spot", details: "Then go there." },
    { label: "Play a public piano or board game" },
    { label: "Collect 5 different leaves", details: "Fallen ones only.", target_count: 5 },
    { label: "Visit a place none of us have been" },
  ],
};

const blank: Pack = {
  id: "blank",
  name: "Blank",
  tagline: "Write your own board together.",
  squares: [],
};

export const PACKS: readonly Pack[] = [nightOut, dayAdventure, blank];

export function getPack(id: PackId): Pack {
  const pack = PACKS.find((p) => p.id === id);
  if (!pack) throw new Error(`Unknown pack: ${id}`);
  return pack;
}

/** Board positions a pack fills, in order: 0–11 then 13–24 (center skipped). */
export const PACK_POSITIONS: readonly number[] = Array.from({ length: 25 }, (_, i) => i).filter(
  (i) => i !== CENTER_POSITION,
);

/** The `squares` payload for `create_game`. */
export function packToSquares(pack: Pack): NewSquare[] {
  return pack.squares.slice(0, PACK_SQUARE_COUNT).map((square, i) => ({
    position: PACK_POSITIONS[i],
    label: square.label,
    ...(square.details ? { details: square.details } : {}),
    ...(square.target_count && square.target_count > 1 ? { target_count: square.target_count } : {}),
  }));
}
