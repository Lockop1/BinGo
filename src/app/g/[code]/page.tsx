import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { JoinScreen } from "@/components/join/JoinScreen";
import { PaperPage } from "@/components/paper/PaperPage";
import { SessionGate } from "@/components/providers/SessionGate";
import { SkeletonLines } from "@/components/ui/Skeleton";
import { inviteUrl } from "@/lib/game/links";
import { loadInvitePreview } from "@/lib/og/loadInvitePreview";
import { SITE_NAME, previewCopy } from "@/lib/og/preview";

/** Absolute base for og:image / og:url (the invite host), when configured. */
function appBase(): URL | undefined {
  try {
    return process.env.NEXT_PUBLIC_APP_URL ? new URL(process.env.NEXT_PUBLIC_APP_URL) : undefined;
  } catch {
    return undefined;
  }
}

// Link previews for shared invites: game name + head count from the public, session-less
// peek_game_public RPC; generic copy for unknown codes or errors. The card image is
// ./opengraph-image.tsx (Next adds og:image / twitter:image for it).
// The lookup is uncached on purpose (the preview must follow the game's current status and
// head count), so the page renders <RequestTimeMarker /> to say that request-time metadata is
// intended (Next 16 Cache Components: "generateMetadata > With Cache Components").
export async function generateMetadata({ params }: Pick<PageProps<"/g/[code]">, "params">): Promise<Metadata> {
  const { code: rawCode } = await params;
  const { code, preview } = await loadInvitePreview(rawCode);
  const { title, description } = previewCopy(preview);
  const metadataBase = appBase();
  return {
    ...(metadataBase ? { metadataBase } : {}),
    title,
    description,
    openGraph: { title, description, type: "website", siteName: SITE_NAME, url: inviteUrl(code || rawCode) },
    twitter: { card: "summary_large_image", title, description },
  };
}

// Join route: /g/[code]. Everything below the params read is client-side.
export default function JoinPage({ params }: PageProps<"/g/[code]">) {
  return (
    <PaperPage back>
      <Suspense fallback={<SkeletonLines lines={3} label="Loading game" />}>
        <JoinCode params={params} />
      </Suspense>
      <RequestTimeMarker />
    </PaperPage>
  );
}

/**
 * Renders nothing; tells Next this route has intentional request-time content, so the
 * uncached preview lookup in generateMetadata streams per request instead of tripping
 * "uncached data in generateMetadata()". Inside its own Suspense so the shell still prerenders.
 */
function RequestTimeMarker() {
  return (
    <Suspense fallback={null}>
      <Connection />
    </Suspense>
  );
}

async function Connection() {
  await connection();
  return null;
}

async function JoinCode({ params }: Pick<PageProps<"/g/[code]">, "params">) {
  const { code } = await params;
  return (
    <SessionGate>
      <JoinScreen rawCode={code} />
    </SessionGate>
  );
}
