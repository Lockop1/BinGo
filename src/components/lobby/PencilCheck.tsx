/** A hand-drawn pencil check mark (inline SVG stroke, drawn in on appearance). */
export function PencilCheck({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={`pencil-check ${className ?? ""}`}>
      <path
        d="M3.6 12.9c1.3 1.1 2.9 2.9 4.3 4.9.3.4.8.4 1-.1C11 12.4 15 7.3 20.6 3.9"
        pathLength={1}
        stroke="currentColor"
        strokeWidth={2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
