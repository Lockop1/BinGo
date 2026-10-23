"use client";

import { Check } from "lucide-react";
import { PACKS, type PackId } from "@/content/packs";

const PREVIEW_COUNT = 3;

/** The three starter packs as paper index cards (a radio group). */
export function PackPicker({ value, onChange }: { value: PackId; onChange: (id: PackId) => void }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-4">
      <legend className="mb-1 text-lg leading-7 text-ink-soft">Starter squares</legend>
      {PACKS.map((pack) => {
        const selected = pack.id === value;
        const preview = pack.squares.slice(0, PREVIEW_COUNT);
        return (
          <label
            key={pack.id}
            data-testid={`pack-${pack.id}`}
            className={`index-card relative block min-w-0 cursor-pointer px-3 pb-2 pt-1 transition-transform duration-100 ${
              selected ? "outline-[2.5px] outline-offset-2 outline-ink [outline-style:solid] -rotate-[0.6deg]" : ""
            }`}
          >
            <input
              type="radio"
              name="pack"
              value={pack.id}
              checked={selected}
              onChange={() => onChange(pack.id)}
              className="sr-only"
            />
            <span className="flex h-[34px] items-center justify-between gap-2">
              <span className="truncate text-2xl leading-none">{pack.name}</span>
              <span
                aria-hidden
                className={`flex size-6 shrink-0 items-center justify-center pencil-border ${selected ? "bg-highlight" : ""}`}
              >
                {selected ? <Check className="size-4" strokeWidth={3} /> : null}
              </span>
            </span>
            <span className="block text-base leading-[22px] text-ink-soft">{pack.tagline}</span>
            {preview.length > 0 ? (
              <ul className="text-base leading-[22px]">
                {preview.map((square) => (
                  <li key={square.label} className="truncate">
                    · {square.label}
                  </li>
                ))}
                <li className="text-ink-soft">+ {pack.squares.length - preview.length} more</li>
              </ul>
            ) : (
              <span className="block text-base leading-[22px]">Start from an empty board and fill it in the lobby.</span>
            )}
          </label>
        );
      })}
    </fieldset>
  );
}
