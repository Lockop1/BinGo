import { Plus } from "lucide-react";
import { YourGames } from "@/components/home/YourGames";
import { PaperPage, PaperTitle } from "@/components/paper/PaperPage";
import { SessionGate } from "@/components/providers/SessionGate";
import { PencilLink } from "@/components/ui/PencilButton";

export default function Home() {
  return (
    <PaperPage>
      <PaperTitle>Bingo Night</PaperTitle>
      <PencilLink href="/new" className="mt-[28px] w-full text-2xl" data-testid="new-game">
        <Plus aria-hidden className="size-6" strokeWidth={2.5} />
        New game
      </PencilLink>
      <section className="mt-[56px] flex min-w-0 flex-col" aria-labelledby="your-games-heading">
        <h2 id="your-games-heading" className="text-2xl leading-[28px] text-ink-soft">
          Your games
        </h2>
        <div className="mt-[14px]">
          <SessionGate>
            <YourGames />
          </SessionGate>
        </div>
      </section>
    </PaperPage>
  );
}
