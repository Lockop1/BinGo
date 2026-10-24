"use client";

import { Check, Share2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PencilButton } from "@/components/ui/PencilButton";
import { groupJoinCode } from "@/lib/game/boardText";
import { inviteUrl } from "@/lib/game/links";
import { shareOrCopy } from "@/lib/share";

type Feedback = "copied" | "failed" | null;

/** Big grouped join code plus "Invite friends" (share sheet, or copy the link). */
export function InviteBlock({ code, gameName }: { code: string; gameName: string }) {
  const [feedback, setFeedback] = useState<Feedback>(null);
  const timer = useRef<number | undefined>(undefined);
  const url = inviteUrl(code);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const invite = async () => {
    // The invite copies the bare link (the code above is what people read out).
    const outcome = await shareOrCopy({ title: gameName, text: "Join our bingo night", url }, { copy: "url" });
    if (outcome === "shared" || outcome === "dismissed") return;
    setFeedback(outcome === "copied" ? "copied" : "failed");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFeedback(null), 2500);
  };

  return (
    <section className="mt-[14px] flex min-w-0 flex-col" aria-label="Invite">
      <p className="text-lg leading-7 text-ink-soft">Invite code</p>
      <p className="text-[40px] leading-[56px] tracking-[0.14em] whitespace-nowrap">
        <span data-testid="invite-code" data-code={code} className="sr-only">
          {code.split("").join(" ")}
        </span>
        <span aria-hidden>{groupJoinCode(code)}</span>
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <PencilButton variant="secondary" onClick={() => void invite()} data-testid="invite-share">
          <Share2 aria-hidden className="size-5" strokeWidth={2.25} />
          Invite friends
        </PencilButton>
        <span aria-live="polite" data-testid="invite-feedback" className="inline-flex min-h-7 items-center gap-1 text-lg">
          {feedback === "copied" ? (
            <>
              <Check aria-hidden className="size-4" strokeWidth={3} />
              Copied
            </>
          ) : feedback === "failed" ? (
            <span className="text-danger">Couldn&apos;t copy. Share the code instead.</span>
          ) : null}
        </span>
      </div>
      <p className="mt-1 truncate text-base leading-7 text-ink-soft" data-testid="invite-url">
        {url}
      </p>
    </section>
  );
}
