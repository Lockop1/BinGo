import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Lined loose-leaf page used by home, create, join and the lobby. Content sits
 * right of the red margin line; the page never scrolls horizontally.
 */
export function PaperPage({ children, back = false }: { children: ReactNode; back?: boolean }) {
  return (
    <main
      className="paper flex w-full min-w-0 flex-1 flex-col overflow-x-hidden pb-[max(2rem,env(safe-area-inset-bottom))] pl-[calc(var(--margin-x)+12px)] pr-4 pt-[max(1rem,env(safe-area-inset-top))]"
    >
      <div className="mx-auto flex w-full max-w-xl min-w-0 flex-1 flex-col">
        {back ? (
          <Link
            href="/"
            className="-ml-2 mb-1 inline-flex min-h-11 w-fit items-center gap-1 px-2 text-lg text-ink-soft"
          >
            <ChevronLeft aria-hidden className="size-5" strokeWidth={2.25} />
            Home
          </Link>
        ) : null}
        {children}
      </div>
    </main>
  );
}

/** Page heading in pencil, sized to sit on the paper's rules. */
export function PaperTitle({ children, as: Tag = "h1" }: { children: ReactNode; as?: "h1" | "h2" }) {
  return <Tag className="text-4xl leading-[56px] tracking-wide break-words">{children}</Tag>;
}
