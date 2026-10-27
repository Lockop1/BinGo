/**
 * Center-square sheet body while the free space is on. Free space is chosen on
 * the Create screen only: nobody can change it in the lobby, so there is no
 * control here, just what it means.
 */
export function FreeSpaceInfo() {
  return (
    <div className="flex min-w-0 flex-col gap-[14px] pb-4" data-testid="free-space-info">
      <p className="text-xl leading-7">The center is a free space: it starts crossed off for everyone.</p>
      <p className="text-lg leading-7 text-ink-soft">Free space was set when the game was created.</p>
    </div>
  );
}
