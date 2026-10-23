/** Pencil-grey placeholder lines. No spinner, no shimmer. */
export function SkeletonLines({ lines = 3, label = "Loading" }: { lines?: number; label?: string }) {
  const widths = ["78%", "62%", "70%", "54%", "66%"];
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-[14px] py-[7px]">
      {Array.from({ length: lines }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className="block h-[14px] rounded-[6px_3px_7px_4px] bg-ink-faint opacity-70"
          style={{ width: widths[i % widths.length] }}
        />
      ))}
    </div>
  );
}
