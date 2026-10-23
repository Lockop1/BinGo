"use client";

import { Toggle } from "@/components/ui/Toggle";

/** Center-square sheet body while the free space is on. */
export function FreeSpaceInfo({
  isHost,
  hostName,
  freeCenter,
  busy,
  error,
  onToggle,
}: {
  isHost: boolean;
  hostName: string;
  freeCenter: boolean;
  busy: boolean;
  error: string | null;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-[14px] pb-4" data-testid="free-space-info">
      <p className="text-xl leading-7">
        The center is a free space: it starts crossed off for everyone.
      </p>
      {isHost ? (
        <>
          <Toggle
            checked={freeCenter}
            onChange={onToggle}
            busy={busy}
            label="Free space in the center"
            description="Turn it off to make the center a normal square."
            testId="free-center-sheet-toggle"
          />
        </>
      ) : (
        <p className="text-lg leading-7 text-ink-soft">
          {hostName || "The host"} (the host) can turn it off to make it a normal square.
        </p>
      )}
      {error ? (
        <p role="alert" className="text-lg leading-7 text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
