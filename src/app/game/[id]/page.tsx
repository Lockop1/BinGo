import { Suspense } from "react";
import { GameScreen } from "@/components/game/GameScreen";
import { PaperPage } from "@/components/paper/PaperPage";
import { SessionGate } from "@/components/providers/SessionGate";
import { SkeletonLines } from "@/components/ui/Skeleton";

// Game route: /game/[id] (lobby, live board, recap). Data loads client-side.
export default function GamePage({ params }: PageProps<"/game/[id]">) {
  return (
    <PaperPage>
      <Suspense fallback={<SkeletonLines lines={4} label="Loading game" />}>
        <GameId params={params} />
      </Suspense>
    </PaperPage>
  );
}

async function GameId({ params }: Pick<PageProps<"/game/[id]">, "params">) {
  const { id } = await params;
  return (
    <SessionGate>
      <GameScreen gameId={id} />
    </SessionGate>
  );
}
