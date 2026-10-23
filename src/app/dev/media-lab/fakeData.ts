import type { Game, Media, Player, Square } from "@/lib/game/types";

/** Fake ended game for the recap lab. Fixed dates keep the page deterministic. */

const GAME_ID = "00000000-0000-4000-8000-00000000fa6e";
const AT = "2026-10-17T20:00:00.000Z";

export const LAB_GAME: Game = {
  id: GAME_ID,
  join_code: "LABC2345",
  name: "Lab Night Out",
  host_user_id: "u-jake",
  status: "ended",
  free_center: true,
  created_at: AT,
  started_at: AT,
  ended_at: "2026-10-18T04:00:00.000Z",
  auto_end_at: "2026-10-18T20:00:00.000Z",
  expires_at: "2026-11-16T20:00:00.000Z",
};

const player = (id: string, name: string, color: number, minute: number): Player => ({
  id,
  game_id: GAME_ID,
  user_id: `u-${id}`,
  display_name: name,
  color,
  is_ready: true,
  joined_at: `2026-10-17T20:${String(minute).padStart(2, "0")}:00.000Z`,
});

export const LAB_PLAYERS: Player[] = [
  player("jake", "Jake", 0, 0),
  player("priya", "Priya", 4, 1),
  player("sam", "Sam", 6, 2),
  player("lee", "Lee", 2, 3),
];

const LABELS = [
  "High-five a stranger",
  "Find a jukebox",
  "Skyline Chili",
  "Learn a bartender's name",
  "Group photo with a mural",
  "Order in another language",
  "Find a penny",
  "Karaoke duet",
  "Compliment a hat",
  "Take the stairs",
  "Spot a vintage car",
  "Try a new snack",
  "",
  "Dance for 10 seconds",
  "Find a four-leaf clover",
  "Ride a carousel",
  "Get a free sample",
  "Name a constellation",
  "Sunrise photo",
  "Tell a terrible pun",
  "Play a board game",
  "Find a hidden mural",
  "Teach someone a word",
  "Visit a bookstore",
  "Wave at a bus",
];

/** Row 1 and Column 3 complete (2 lines); the free center has no completer. */
const COMPLETED: Record<number, string | null> = {
  0: "jake",
  1: "sam",
  2: "priya",
  3: "jake",
  4: "priya",
  7: "jake",
  12: null,
  17: "sam",
  18: "sam",
  22: "priya",
};

export const LAB_SQUARES: Square[] = LABELS.map((label, position) => {
  const done = position in COMPLETED;
  return {
    id: `sq-${position}`,
    game_id: GAME_ID,
    position,
    label,
    details: "",
    target_count: 1,
    current_count: done ? 1 : 0,
    completed_by_player_id: done ? COMPLETED[position] : null,
    completed_at: done ? AT : null,
    updated_at: AT,
  };
});

type FakeMedia = { id: string; position: number; player: string; kind: Media["kind"]; at: string; color: string };

/**
 * Created out of board order on purpose. Story order must be:
 * square 2 (20:30, 22:10), square 7 (21:05 video, 23:00), square 18.
 */
export const LAB_MEDIA_SPEC: FakeMedia[] = [
  { id: "m-sunrise", position: 18, player: "sam", kind: "photo", at: "21:40", color: "#c24600" },
  { id: "m-chili-2", position: 2, player: "priya", kind: "photo", at: "22:10", color: "#00796b" },
  { id: "m-karaoke-video", position: 7, player: "jake", kind: "video", at: "21:05", color: "#1d4ed8" },
  { id: "m-chili-1", position: 2, player: "jake", kind: "photo", at: "20:30", color: "#a8141b" },
  { id: "m-karaoke-2", position: 7, player: "priya", kind: "photo", at: "23:00", color: "#2e7d32" },
];

export function labMedia(videoOk: boolean): Media[] {
  return LAB_MEDIA_SPEC.map((m) => {
    const kind = m.kind === "video" && !videoOk ? "photo" : m.kind;
    return {
      id: m.id,
      game_id: GAME_ID,
      square_id: `sq-${m.position}`,
      player_id: m.player,
      storage_path: `${GAME_ID}/${m.position}/${m.id}.${kind === "video" ? "webm" : "jpg"}`,
      kind,
      created_at: `2026-10-17T${m.at}:00.000Z`,
    };
  });
}

/** A distinct JPEG data: URL per item (canvas-drawn, portrait). */
export function photoDataUrl(text: string, color: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = 600;
  canvas.height = 800;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 600, 800);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 44px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(text, 300, 400, 560);
  return canvas.toDataURL("image/jpeg", 0.8);
}

/** Records `ms` of an animated canvas with MediaRecorder (webm). Null if unsupported. */
export async function recordCanvasWebm(ms: number, label = "video"): Promise<Blob | null> {
  if (typeof MediaRecorder === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const ctx = canvas.getContext("2d");
  if (!ctx || typeof canvas.captureStream !== "function") return null;
  const type = ["video/webm;codecs=vp8", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
  if (!type) return null;
  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType: type });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
  let frame = 0;
  let raf = 0;
  const draw = () => {
    frame += 1;
    ctx.fillStyle = `hsl(${(frame * 6) % 360} 70% 40%)`;
    ctx.fillRect(0, 0, 320, 240);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 28px sans-serif";
    ctx.fillText(`${label} ${frame}`, 20, 130);
    raf = requestAnimationFrame(draw);
  };
  draw();
  recorder.start(100);
  await new Promise((r) => setTimeout(r, ms));
  recorder.stop();
  await stopped;
  cancelAnimationFrame(raf);
  stream.getTracks().forEach((t) => t.stop());
  return new Blob(chunks, { type: "video/webm" });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
