import { Suspense } from "react";

// Game route: /game/[id] (lobby, live board, recap). Placeholder until Phase 3.
export default function GamePage({ params }: PageProps<"/game/[id]">) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 px-4">
      <h1 className="text-2xl font-semibold">Game</h1>
      <Suspense fallback={null}>
        <GameId params={params} />
      </Suspense>
    </main>
  );
}

async function GameId({ params }: Pick<PageProps<"/game/[id]">, "params">) {
  const { id } = await params;
  return <p className="font-mono text-sm opacity-70">{id}</p>;
}
