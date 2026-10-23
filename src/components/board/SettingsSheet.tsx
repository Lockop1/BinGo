import type { Game } from "@/lib/game/types";
import { autoEndLabel } from "@/components/board/PlayersSheet";

/**
 * Placeholder settings sheet (Phase 5 brings theme, text size and square
 * size). Kept real: it shows when the game ends on its own.
 */
export function SettingsSheetBody({ game }: { game: Game }) {
  const ends = autoEndLabel(game.auto_end_at);
  return (
    <div className="flex min-w-0 flex-col gap-[14px] pb-2" data-testid="settings-sheet-body">
      <p className="text-xl leading-7">Board theme, text size and square size are coming soon.</p>
      {ends ? (
        <p className="text-lg leading-7 text-ink-soft" data-testid="settings-auto-end">
          This game ends automatically at {ends}.
        </p>
      ) : null}
    </div>
  );
}
