import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ImageResponse } from "next/og";
import { connection } from "next/server";
import { Logo } from "@/components/brand/Logo";
import { LOGO_INK, LOGO_RED } from "@/components/brand/logoArt";
import { BOARD_BOX, BOARD_LINES, CROSSED_CELLS, SAMPLE_LABELS, cellCenter, crossOff } from "@/lib/og/boardArt";
import { loadInvitePreview } from "@/lib/og/loadInvitePreview";
import { SITE_NAME, groupJoinCode, headingFontSize, previewCopy } from "@/lib/og/preview";

// Invite-link card (og:image / twitter:image for /g/[code]): a whiteboard with the game name.
// Uses only the public, session-less peek_game_public RPC (anon key, no cookies); an unknown
// code or any lookup error renders the generic card, never an error.

export const alt = "Bingo Night board";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK_SOFT = "#4f5459";
const LABEL_INK = "#5d6268";
const BOARD_PX = 470;
// The board SVG's viewBox pads the 520-unit board by 6 on each side for the strokes.
const BOARD_PAD = 6;
const BOARD_SCALE = BOARD_PX / (BOARD_BOX + 2 * BOARD_PAD);
const LABEL_PX = 74;

/** Board units → px inside the board box. */
const toPx = (units: number) => (units + BOARD_PAD) * BOARD_SCALE;
const fill = { position: "absolute", left: 0, top: 0, width: BOARD_PX, height: BOARD_PX } as const;

type FontSpec = { name: string; data: ArrayBuffer; weight: 400; style: "normal" };

async function loadFont(url: URL): Promise<ArrayBuffer> {
  // Bundled next to this file. Node's fetch has no file: support, so read those from disk.
  if (url.protocol === "file:") {
    const buffer = await readFile(fileURLToPath(url));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  }
  return (await fetch(url)).arrayBuffer();
}

let fontsPromise: Promise<FontSpec[]> | null = null;

/**
 * Reads the bundled fonts on first use (not at module scope: the page's metadata evaluates
 * this module while prerendering, where I/O must not start) and keeps them for the life of
 * the server. A missing font must not break the card: satori falls back to its built-in
 * font, and the next request tries again.
 */
function loadFonts(): Promise<FontSpec[]> {
  fontsPromise ??= Promise.all([
    loadFont(new URL("./fonts/PermanentMarker-Regular.ttf", import.meta.url)),
    loadFont(new URL("./fonts/PatrickHand-Regular.ttf", import.meta.url)),
  ])
    .then(([marker, pencil]): FontSpec[] => [
      { name: "Permanent Marker", data: marker, weight: 400, style: "normal" },
      { name: "Patrick Hand", data: pencil, weight: 400, style: "normal" },
    ])
    .catch((error: unknown) => {
      console.error("[og] could not load card fonts", error);
      fontsPromise = null;
      return [];
    });
  return fontsPromise;
}

export default async function Image({ params }: { params: Promise<{ code: string }> }) {
  // Player counts change: render per request (the Cache-Control below lets CDNs and
  // unfurlers keep a copy for a while).
  await connection();
  const { code: rawCode } = await params;
  const [{ code, preview }, fonts] = await Promise.all([loadInvitePreview(rawCode), loadFonts()]);
  const copy = previewCopy(preview);
  const heading = copy.heading ?? "Join the game";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "#ffffff",
          padding: "56px 64px 56px 72px",
          color: LOGO_INK,
          fontFamily: "Patrick Hand",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            width: 590,
            height: "100%",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <Logo size={68} />
            <div style={{ fontFamily: "Permanent Marker", fontSize: 40, lineHeight: 1 }}>{SITE_NAME}</div>
          </div>

          <div style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{
                fontFamily: "Permanent Marker",
                fontSize: headingFontSize(heading),
                lineHeight: 1.12,
                // Clamped to ~40 chars upstream and sized to fit two lines; this is the backstop.
                display: "block",
                lineClamp: 2,
                wordBreak: "break-word",
              }}
            >
              {heading}
            </div>
            <div style={{ display: "flex", fontSize: 44, lineHeight: 1.2, marginTop: 22, color: INK_SOFT }}>
              {copy.subline}
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "baseline", fontSize: 32, color: INK_SOFT }}>
            {preview ? (
              <>
                <span>Code</span>
                <span style={{ marginLeft: 14, color: LOGO_INK, letterSpacing: 2 }}>{groupJoinCode(code)}</span>
              </>
            ) : (
              <span>Activity bingo for a night out with friends</span>
            )}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            position: "relative",
            width: BOARD_PX,
            height: BOARD_PX,
            transform: "rotate(-2deg)",
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox={`${-BOARD_PAD} ${-BOARD_PAD} ${BOARD_BOX + 2 * BOARD_PAD} ${BOARD_BOX + 2 * BOARD_PAD}`}
            width={BOARD_PX}
            height={BOARD_PX}
            style={fill}
          >
            {BOARD_LINES.map((d) => (
              <path
                key={d}
                d={d}
                fill="none"
                stroke={LOGO_INK}
                strokeWidth={13}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
          </svg>
          {SAMPLE_LABELS.map(([row, col, text]) => {
            const { x, y } = cellCenter(row, col);
            return (
              <div
                key={text}
                style={{
                  position: "absolute",
                  left: toPx(x) - LABEL_PX / 2,
                  top: toPx(y) - LABEL_PX / 2,
                  width: LABEL_PX,
                  height: LABEL_PX,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  textAlign: "center",
                  fontSize: 19,
                  lineHeight: 1.05,
                  color: LABEL_INK,
                }}
              >
                {text}
              </div>
            );
          })}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox={`${-BOARD_PAD} ${-BOARD_PAD} ${BOARD_BOX + 2 * BOARD_PAD} ${BOARD_BOX + 2 * BOARD_PAD}`}
            width={BOARD_PX}
            height={BOARD_PX}
            style={fill}
          >
            {CROSSED_CELLS.flatMap(([row, col]) =>
              crossOff(row, col).map((d, i) => (
                <path
                  key={d}
                  d={d}
                  fill="none"
                  stroke={LOGO_RED}
                  strokeWidth={i === 2 ? 7 : 10}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )),
            )}
          </svg>
          {preview && !preview.free_center ? null : (
            <div
              style={{
                ...fill,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: "Permanent Marker",
                fontSize: 30,
                color: LOGO_INK,
              }}
            >
              FREE
            </div>
          )}
        </div>
      </div>
    ),
    {
      ...size,
      fonts,
      headers: { "Cache-Control": "public, max-age=120, s-maxage=300, stale-while-revalidate=3600" },
    },
  );
}
