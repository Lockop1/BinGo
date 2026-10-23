import type { Metadata } from "next";
import { Suspense } from "react";
import { JoinScreen } from "@/components/join/JoinScreen";
import { PaperPage } from "@/components/paper/PaperPage";
import { SessionGate } from "@/components/providers/SessionGate";
import { SkeletonLines } from "@/components/ui/Skeleton";

export const metadata: Metadata = { title: "Join game · Bingo Night" };

// Join route: /g/[code]. Everything below the params read is client-side.
export default function JoinPage({ params }: PageProps<"/g/[code]">) {
  return (
    <PaperPage back>
      <Suspense fallback={<SkeletonLines lines={3} label="Loading game" />}>
        <JoinCode params={params} />
      </Suspense>
    </PaperPage>
  );
}

async function JoinCode({ params }: Pick<PageProps<"/g/[code]">, "params">) {
  const { code } = await params;
  return (
    <SessionGate>
      <JoinScreen rawCode={code} />
    </SessionGate>
  );
}
