import type { Metadata } from "next";
import { CreateGameForm } from "@/components/create/CreateGameForm";
import { PaperPage, PaperTitle } from "@/components/paper/PaperPage";

export const metadata: Metadata = { title: "New game · Bingo Night" };

export default function NewGamePage() {
  return (
    <PaperPage back>
      <PaperTitle>New game</PaperTitle>
      <div className="mt-[14px]">
        <CreateGameForm />
      </div>
    </PaperPage>
  );
}
