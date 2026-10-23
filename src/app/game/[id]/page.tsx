import { Suspense } from "react";
import { GameScreen } from "@/components/game/GameScreen";
import { PaperPage } from "@/components/paper/PaperPage";
import { SkeletonLines } from "@/components/ui/Skeleton";

// Game route: /game/[id] (lobby, live board, recap). Data loads client-side.
// GameScreen picks the frame: paper for lobby / loading / ended, the full
// viewport for the live board.
export default function GamePage({ params }: PageProps<"/game/[id]">) {
  return (
    <Suspense
      fallback={
        <PaperPage>
          <SkeletonLines lines={4} label="Loading game" />
        </PaperPage>
      }
    >
      <GameId params={params} />
    </Suspense>
  );
}

async function GameId({ params }: Pick<PageProps<"/game/[id]">, "params">) {
  const { id } = await params;
  return <GameScreen gameId={id} />;
}
