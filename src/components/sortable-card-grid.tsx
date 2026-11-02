"use client";

import { useCallback } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import { SortableCard } from "@/components/sortable-card";
import type { CardEntry } from "@/lib/dashboard/card-registry";

export interface SortableCardGridProps {
  cards: CardEntry[];
  /** Each card's size limits, from its definition. */
  limitsOf: (card: CardEntry) => { minSize: number; maxSize: number };
  renderCard: (card: CardEntry) => React.ReactNode;
  onLayoutChange: (cards: CardEntry[]) => void;
}

/**
 * The dashboard grid in edit mode: cards dragged into a new order, resized and
 * removed. Its own module — loaded only once the user starts customizing —
 * because it is the only part of the dashboard that needs the drag-and-drop
 * library.
 */
export function SortableCardGrid({ cards, limitsOf, renderCard, onLayoutChange }: SortableCardGridProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = cards.findIndex((c) => c.id === active.id);
      const newIndex = cards.findIndex((c) => c.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      onLayoutChange(arrayMove(cards, oldIndex, newIndex));
    },
    [cards, onLayoutChange],
  );

  const update = (cardId: string, change: (card: CardEntry) => CardEntry) =>
    onLayoutChange(cards.map((c) => (c.id === cardId ? change(c) : c)));

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={cards.map((c) => c.id)} strategy={rectSortingStrategy}>
        {cards.map((card) => {
          const { minSize, maxSize } = limitsOf(card);
          return (
            <SortableCard
              key={card.id}
              id={card.id}
              size={card.size}
              heightPx={card.heightPx}
              minSize={minSize}
              maxSize={maxSize}
              editMode
              onRemove={() => onLayoutChange(cards.filter((c) => c.id !== card.id))}
              onResize={(newSize) => update(card.id, (c) => ({ ...c, size: newSize }))}
              onHeightResize={(newHeight) => update(card.id, (c) => ({ ...c, heightPx: newHeight }))}
              onHeightReset={() =>
                update(card.id, (c) => ({ id: c.id, size: c.size, ...(c.config && { config: c.config }) }))
              }
            >
              {renderCard(card)}
            </SortableCard>
          );
        })}
      </SortableContext>
    </DndContext>
  );
}
