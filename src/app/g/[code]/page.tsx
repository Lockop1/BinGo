import { Suspense } from "react";

// Join route: /g/[code]. Placeholder until Phase 2 (join flow).
export default function JoinPage({ params }: PageProps<"/g/[code]">) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 px-4">
      <h1 className="text-2xl font-semibold">Join game</h1>
      <Suspense fallback={null}>
        <JoinCode params={params} />
      </Suspense>
    </main>
  );
}

async function JoinCode({ params }: Pick<PageProps<"/g/[code]">, "params">) {
  const { code } = await params;
  return <p className="font-mono text-sm opacity-70">{code}</p>;
}
