import { CENTER_POSITION } from "@/lib/game/types";
import { jitter, labelSize } from "@/lib/game/boardText";

export type BoardSquare = {
  position: number;
  label: string;
  target_count: number;
  /** An optimistic edit from this phone is still being saved. */
  pending: boolean;
};

const SIZE = 500;
const CELL = SIZE / 5;
const WOBBLE = 3.2; // viewBox units (≈0.6% of the width)

/** Grid lines as slightly crooked pencil strokes (deterministic per line). */
function gridPaths(): string[] {
  const paths: string[] = [];
  for (let i = 0; i <= 5; i++) {
    const at = Math.min(Math.max(i * CELL, 1.5), SIZE - 1.5);
    const a = jitter(i + 1) * WOBBLE;
    const b = jitter(i + 11) * WOBBLE;
    const c = jitter(i + 21) * WOBBLE * 0.8;
    // Horizontal, then vertical; each overshoots the frame a hair like a ruled pencil line.
    paths.push(`M ${-2 + c} ${at + a} Q ${SIZE / 2 + b * 6} ${at - b} ${SIZE + 1 - c} ${at + c}`);
    paths.push(`M ${at + b} ${-1 - c} Q ${at - a} ${SIZE / 2 + a * 6} ${at + c} ${SIZE + 2 + c}`);
  }
  return paths;
}
const PATHS = gridPaths();

/** A word this long rarely fits a 320 px phone's cell: CSS sets it a step smaller there. */
const LONG_WORD = 9;
function longWord(label: string): true | undefined {
  return label.split(/\s+/).some((word) => word.length >= LONG_WORD) || undefined;
}

/** The 5×5 lobby board on paper. Only labels show here; details live in the sheet. */
export function LobbyBoard({
  squares,
  freeCenter,
  onSelect,
}: {
  squares: BoardSquare[];
  freeCenter: boolean;
  onSelect: (position: number) => void;
}) {
  return (
    <section className="mt-[28px] min-w-0" aria-labelledby="board-heading">
      <h2 id="board-heading" className="text-2xl leading-7">
        The board
      </h2>
      <p className="text-lg leading-7 text-ink-soft">Tap any square to write on it.</p>
      <div className="relative mt-[7px] w-full min-w-0">
        <ol className="grid w-full grid-cols-5" data-testid="board">
          {squares.map((square) => {
            const isFree = square.position === CENTER_POSITION && freeCenter;
            const counter = square.target_count > 1 ? square.target_count : null;
            const label = square.label.trim();
            const name = isFree
              ? `Center: free space${label ? `, ${label}` : ""}`
              : `Square ${square.position + 1}: ${label || "empty"}${counter ? `, counter to ${counter}` : ""}`;
            return (
              <li key={square.position} className="lobby-cell aspect-square min-w-0">
                <button
                  type="button"
                  onClick={() => onSelect(square.position)}
                  data-testid={`square-${square.position}`}
                  data-position={square.position}
                  data-free={isFree}
                  data-pending={square.pending || undefined}
                  aria-label={name}
                  className={`relative flex size-full min-w-0 flex-col items-center overflow-hidden p-1 text-center text-ink focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-ink active:bg-highlight/60 ${
                    counter && !isFree ? "justify-start pt-0" : "justify-center"
                  } ${square.pending ? "text-ink-soft" : ""}`}
                  style={{ transform: `rotate(${(jitter(square.position + 40) * 0.6).toFixed(2)}deg)` }}
                >
                  {/* A counter's "×15" gets its own row in the top-right corner (never over the
                      label); the label takes the rest of the cell, two lines at most. */}
                  {counter && !isFree ? (
                    <span
                      className="shrink-0 self-end pr-px text-[11px] leading-[13px] text-ink-soft"
                      data-testid="counter-badge"
                    >
                      ×{counter}
                    </span>
                  ) : null}
                  {isFree ? (
                    <>
                      <span className="text-xl leading-6 tracking-wider">FREE</span>
                      {label ? (
                        <span className="square-label text-ink-soft" data-size="sm" data-long-word={longWord(label)}>
                          {label}
                        </span>
                      ) : null}
                    </>
                  ) : label ? (
                    counter ? (
                      <span className="flex min-h-0 w-full min-w-0 flex-1 items-center justify-center pb-0.5">
                        <span
                          className="square-label"
                          data-size={labelSize(label)}
                          data-lines="2"
                          data-long-word={longWord(label)}
                        >
                          {label}
                        </span>
                      </span>
                    ) : (
                      <span className="square-label" data-size={labelSize(label)} data-long-word={longWord(label)}>
                        {label}
                      </span>
                    )
                  ) : (
                    <span
                      aria-hidden
                      className={`text-lg leading-none text-ink-faint ${counter ? "flex flex-1 items-center" : ""}`}
                    >
                      +
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 size-full overflow-visible"
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          preserveAspectRatio="none"
        >
          {PATHS.map((d, i) => (
            <path
              key={i}
              d={d}
              fill="none"
              stroke="var(--ink)"
              strokeWidth={2}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              opacity={0.9}
            />
          ))}
        </svg>
      </div>
    </section>
  );
}
