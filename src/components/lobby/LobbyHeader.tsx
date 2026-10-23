import Link from "next/link";
import { LogOut } from "lucide-react";
import { SyncDot } from "@/components/lobby/SyncDot";
import type { SyncState } from "@/lib/game/useGame";

export function LobbyHeader({
  name,
  syncState,
  onResync,
}: {
  name: string;
  syncState: SyncState;
  onResync: () => void;
}) {
  return (
    <header className="flex min-w-0 flex-col">
      <div className="flex min-h-11 items-center justify-between gap-2">
        <SyncDot state={syncState} onResync={onResync} />
        <Link
          href="/"
          data-testid="leave-lobby"
          className="-mr-2 inline-flex min-h-11 items-center gap-1.5 px-2 text-lg text-ink-soft underline decoration-ink-faint decoration-2 underline-offset-4"
        >
          <LogOut aria-hidden className="size-4" strokeWidth={2.25} />
          Leave
        </Link>
      </div>
      <h1 className="font-pencil text-4xl leading-[56px] tracking-wide break-words" data-testid="lobby-title">
        {name}
      </h1>
      <p className="text-lg leading-7 text-ink-soft">Lobby · fill the board together, then tap Ready.</p>
    </header>
  );
}
