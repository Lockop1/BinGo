"use client";

import { useMemo, useState } from "react";
import { RecapStory } from "@/components/recap/RecapStory";
import { RecapSummary } from "@/components/recap/RecapSummary";
import { buildRecapItems, recapFileNames } from "@/components/recap/recapItems";
import type { Game, Media, Player, Square } from "@/lib/game/types";
import { getSignedUrls as defaultGetSignedUrls, type GetSignedUrls } from "@/lib/media/signedUrls";

type Props = {
  game: Pick<Game, "name" | "expires_at">;
  players: readonly Player[];
  squares: readonly Square[];
  media: readonly Media[];
  /** Defaults to real signed URLs from `game-media`; tests pass data: URLs. */
  getSignedUrls?: GetSignedUrls;
  headingLevel?: "h1" | "h2";
};

/** The ended game's recap: the paper summary, and the story viewer on "Watch the recap". */
export function Recap({ game, players, squares, media, getSignedUrls = defaultGetSignedUrls, headingLevel }: Props) {
  const items = useMemo(() => buildRecapItems(media, squares, players), [media, squares, players]);
  const names = useMemo(() => recapFileNames(items), [items]);
  const [open, setOpen] = useState(false);

  return (
    <>
      <RecapSummary
        game={game}
        players={players}
        squares={squares}
        items={items}
        names={names}
        getSignedUrls={getSignedUrls}
        onWatch={() => setOpen(true)}
        headingLevel={headingLevel}
      />
      {open && items.length > 0 ? (
        <RecapStory items={items} names={names} getSignedUrls={getSignedUrls} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
