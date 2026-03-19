"use client";

import { useCallback } from "react";
import { cn } from "@/lib/utils";

const LETTERS = [
  "#",
  "A", "B", "C", "D", "E", "F", "G", "H", "I",
  "J", "K", "L", "M", "N", "O", "P", "Q", "R",
  "S", "T", "U", "V", "W", "X", "Y", "Z",
];

interface AlphabetFilterProps {
  activeLetter: string | null;
  onLetterClick: (letter: string) => void;
  availableLetters?: Set<string>;
}

function LetterButton({
  letter,
  isActive,
  isAvailable,
  isFocusTarget,
  onClick,
}: {
  letter: string;
  isActive: boolean;
  isAvailable: boolean;
  isFocusTarget: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={() => isAvailable && onClick()}
      disabled={!isAvailable}
      tabIndex={isFocusTarget ? 0 : -1}
      aria-label={`Jump to ${letter === "#" ? "numbers" : letter}`}
      aria-current={isActive ? "true" : undefined}
      data-letter={letter}
      className={cn(
        "flex h-7 w-8 shrink-0 items-center justify-center rounded text-[16px] font-semibold leading-none transition-colors",
        isActive
          ? "bg-primary text-primary-foreground"
          : isAvailable
            ? "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            : "cursor-default text-muted-foreground/30",
      )}
    >
      {letter}
    </button>
  );
}

export function AlphabetFilter({
  activeLetter,
  onLetterClick,
  availableLetters,
}: AlphabetFilterProps) {
  // Determine which letter gets tabIndex={0} (roving tabindex)
  const focusLetter = activeLetter ?? LETTERS.find((l) => !availableLetters || availableLetters.has(l)) ?? LETTERS[0];

  // Roving tabindex keyboard handler
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
      e.preventDefault();

      const nav = e.currentTarget;
      const buttons = Array.from(nav.querySelectorAll<HTMLButtonElement>("button:not([disabled])"));
      if (buttons.length === 0) return;

      const current = nav.querySelector<HTMLButtonElement>("button:focus");
      const currentIndex = current ? buttons.indexOf(current) : -1;

      let nextIndex: number;
      if (e.key === "Home") {
        nextIndex = 0;
      } else if (e.key === "End") {
        nextIndex = buttons.length - 1;
      } else if (e.key === "ArrowUp") {
        nextIndex = currentIndex <= 0 ? buttons.length - 1 : currentIndex - 1;
      } else {
        nextIndex = currentIndex >= buttons.length - 1 ? 0 : currentIndex + 1;
      }

      buttons[nextIndex].focus();
    },
    [],
  );

  return (
    <nav
      className="fixed right-1.5 top-1/2 z-30 hidden -translate-y-1/2 flex-col items-center md:flex"
      aria-label="Alphabetical navigation"
      role="toolbar"
      aria-orientation="vertical"
      onKeyDown={handleKeyDown}
    >
      {LETTERS.map((letter) => {
        const isActive = activeLetter === letter;
        const isAvailable = !availableLetters || availableLetters.has(letter);
        return (
          <LetterButton
            key={letter}
            letter={letter}
            isActive={isActive}
            isAvailable={isAvailable}
            isFocusTarget={letter === focusLetter}
            onClick={() => onLetterClick(letter)}
          />
        );
      })}
    </nav>
  );
}
