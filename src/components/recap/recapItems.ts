import type { Media, Player, Square } from "@/lib/game/types";

export type RecapItem = {
  media: Media;
  square: Square;
  /** Who completed the square (null for the free center). */
  completer: Player | null;
  /** Who added this photo/video (may differ from the completer). */
  uploader: Player | null;
};

/**
 * Story order: board order (position asc), then upload time within a square.
 * Media whose square is unknown is skipped; squares without media never appear.
 */
export function buildRecapItems(media: readonly Media[], squares: readonly Square[], players: readonly Player[]): RecapItem[] {
  const squareById = new Map(squares.map((s) => [s.id, s]));
  const playerById = new Map(players.map((p) => [p.id, p]));
  const items: RecapItem[] = [];
  for (const m of media) {
    const square = squareById.get(m.square_id);
    if (!square) continue;
    const completer = square.completed_by_player_id ? playerById.get(square.completed_by_player_id) : undefined;
    items.push({ media: m, square, completer: completer ?? null, uploader: playerById.get(m.player_id) ?? null });
  }
  return items.sort(
    (a, b) =>
      a.square.position - b.square.position ||
      a.media.created_at.localeCompare(b.media.created_at) ||
      a.media.id.localeCompare(b.media.id),
  );
}

/** Square text for display: the free center may be blank. */
export function squareTitle(square: Pick<Square, "label" | "position">): string {
  const label = square.label.trim();
  if (label) return label;
  return square.position === 12 ? "Free space" : `Square ${square.position + 1}`;
}

/** Lower-case, dash-separated, ASCII-only file-name part. */
export function slug(text: string, fallback = "item"): string {
  const s = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || fallback;
}

/** Extension of a storage path ("…/uuid.jpg" → "jpg"). */
export function pathExt(path: string): string {
  const ext = path.split("/").pop()?.split(".").pop()?.toLowerCase();
  return ext && /^[a-z0-9]{2,5}$/.test(ext) ? ext : "bin";
}

/** "03-skyline-chili-jake-2.jpg": board order first so a zip sorts like the story. */
export function recapFileName(item: RecapItem, indexInSquare: number): string {
  const pos = String(item.square.position + 1).padStart(2, "0");
  const by = item.uploader ?? item.completer;
  const who = by ? `-${slug(by.display_name, "player")}` : "";
  const n = indexInSquare > 0 ? `-${indexInSquare + 1}` : "";
  return `${pos}-${slug(squareTitle(item.square), "square")}${who}${n}.${pathExt(item.media.storage_path)}`;
}

/** File names for every item, numbering repeats within a square. */
export function recapFileNames(items: readonly RecapItem[]): string[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const n = seen.get(item.square.id) ?? 0;
    seen.set(item.square.id, n + 1);
    return recapFileName(item, n);
  });
}
