import {
  LOGO_GRID_PATHS,
  LOGO_GRID_WIDTH,
  LOGO_INK,
  LOGO_PAPER,
  LOGO_PAPER_RADIUS,
  LOGO_RED,
  LOGO_STRIKE,
  LOGO_VIEWBOX,
} from "./logoArt";

type LogoProps = {
  /** Rendered width and height in px. */
  size?: number;
  /** Draw the rounded paper square behind the mark (off: just ink + red on whatever is below). */
  paper?: boolean;
  /** Accessible name; omit when a visible "Bingo Night" label sits next to it (decorative). */
  title?: string;
};

/**
 * The Bingo Night logo as inline SVG (same paths as public/icons/logo.svg). Plain SVG with
 * no hooks or CSS, so it also renders inside `ImageResponse` (next/og) for the invite card.
 */
export function Logo({ size = 48, paper = true, title }: LogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${LOGO_VIEWBOX} ${LOGO_VIEWBOX}`}
      width={size}
      height={size}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {paper ? (
        <rect width={LOGO_VIEWBOX} height={LOGO_VIEWBOX} rx={LOGO_PAPER_RADIUS} fill={LOGO_PAPER} />
      ) : null}
      {LOGO_GRID_PATHS.map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke={LOGO_INK}
          strokeWidth={LOGO_GRID_WIDTH}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {LOGO_STRIKE.map(({ d, width }) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke={LOGO_RED}
          strokeWidth={width}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}
