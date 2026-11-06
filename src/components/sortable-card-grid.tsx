"use client";

import { useCallback, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardCode,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Collision,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { SortableContext, type SortingStrategy } from "@dnd-kit/sortable";
import { GripVertical, LayoutDashboard, type LucideIcon } from "lucide-react";
import { SortableCard, type DropMarker } from "@/components/sortable-card";
import {
  CUSTOM_CARD_DEFINITION,
  CUSTOM_CARD_ICONS,
  getCardDefinition,
  isCustomCardId,
  type CardEntry,
} from "@/lib/dashboard/card-registry";
import { cardLabel } from "@/lib/dashboard/card-label";
import {
  adjacentCardId,
  keyboardDropSide,
  moveCard,
  pickDropTarget,
  type DropAxis,
  type DropSide,
} from "@/lib/dashboard/card-drop";

export interface SortableCardGridProps {
  cards: CardEntry[];
  /** Each card's size limits, from its definition. */
  limitsOf: (card: CardEntry) => { minSize: number; maxSize: number };
  renderCard: (card: CardEntry) => React.ReactNode;
  onLayoutChange: (cards: CardEntry[]) => void;
  /** Remove a card (the dashboard offers to undo it). */
  onRemove: (cardId: string) => void;
}

/**
 * Keeps every card where it is while one is dragged. The cards differ in
 * size, so sliding neighbours aside (dnd-kit's rect strategy) stretched and
 * overlapped them; the drop marker shows where the card will land instead.
 */
const holdInPlace: SortingStrategy = () => null;

const KEY_STEPS: Partial<Record<string, -1 | 1>> = {
  [KeyboardCode.Left]: -1,
  [KeyboardCode.Up]: -1,
  [KeyboardCode.Right]: 1,
  [KeyboardCode.Down]: 1,
};

interface DropData {
  side: DropSide;
  axis: DropAxis;
}

/**
 * The marker for the first collision — none where dropping would leave the
 * card where it is (over itself, or beside the place it already holds), so
 * the marker only ever shows a real move.
 */
function markerFrom(collisions: Collision[] | null, activeId: UniqueIdentifier, cards: CardEntry[]): DropMarker | null {
  const first = collisions?.[0];
  const drop = first?.data?.drop as DropData | undefined;
  if (!first || !drop) return null;
  const marker: DropMarker = { id: String(first.id), side: drop.side, axis: drop.axis };
  return moveCard(cards, String(activeId), marker.id, marker.side) === cards ? null : marker;
}

function sameMarker(a: DropMarker | null, b: DropMarker | null): boolean {
  return a === b || (a !== null && b !== null && a.id === b.id && a.side === b.side && a.axis === b.axis);
}

/** What the drag label names: the card's title and icon. */
function cardChrome(card: CardEntry): { label: string; icon: LucideIcon } {
  if (isCustomCardId(card.id)) {
    return {
      label: cardLabel(card),
      icon: (card.config?.icon && CUSTOM_CARD_ICONS[card.config.icon]) || CUSTOM_CARD_DEFINITION.icon,
    };
  }
  return { label: cardLabel(card), icon: getCardDefinition(card.id)?.icon ?? LayoutDashboard };
}

/**
 * The dashboard grid in edit mode: cards dragged into a new order, resized and
 * removed. Its own module — loaded only once the user starts customizing —
 * because it is the only part of the dashboard that needs the drag-and-drop
 * library.
 *
 * A drag targets the card nearest the pointer and lands before or after it
 * by which half of it the pointer is in (`pickDropTarget`); the grid does not
 * reflow until the drop, and a small label follows the pointer instead of the
 * whole card.
 */
export function SortableCardGrid({ cards, limitsOf, renderCard, onLayoutChange, onRemove }: SortableCardGridProps) {
  const ids = useMemo(() => cards.map((c) => c.id), [cards]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [marker, setMarker] = useState<DropMarker | null>(null);

  // Arrow keys step the dragged card from one card to the next in the grid's
  // order: its overlay is moved onto the next card's centre, which the
  // collision detection below reads in place of a pointer.
  const keyboardCoordinates = useCallback<KeyboardCoordinateGetter>(
    (event, { context, currentCoordinates }) => {
      const step = KEY_STEPS[event.code];
      if (step === undefined) return undefined;
      event.preventDefault();
      const { active, over, collisionRect, droppableRects } = context;
      if (!active || !collisionRect) return undefined;
      const nextId = adjacentCardId(ids, String(over?.id ?? active.id), step);
      const rect = nextId !== null ? droppableRects.get(nextId) : undefined;
      if (!rect) return undefined;
      return {
        x: currentCoordinates.x + rect.left + rect.width / 2 - (collisionRect.left + collisionRect.width / 2),
        y: currentCoordinates.y + rect.top + rect.height / 2 - (collisionRect.top + collisionRect.height / 2),
      };
    },
    [ids],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: keyboardCoordinates,
    }),
  );

  const collisionDetection = useCallback<CollisionDetection>(
    ({ active, collisionRect, droppableRects, droppableContainers, pointerCoordinates }) => {
      const point = pointerCoordinates ?? {
        x: collisionRect.left + collisionRect.width / 2,
        y: collisionRect.top + collisionRect.height / 2,
      };
      const candidates = droppableContainers.flatMap((container) => {
        const rect = droppableRects.get(container.id);
        return rect ? [{ id: container.id, rect }] : [];
      });
      const target = pickDropTarget(point, candidates);
      const container = target && droppableContainers.find((c) => c.id === target.id);
      if (!target || !container) return [];
      const side = pointerCoordinates
        ? target.side
        : keyboardDropSide(ids, String(active.id), String(target.id));
      const drop: DropData = { side, axis: target.axis };
      return [{ id: target.id, data: { droppableContainer: container, value: target.distance, drop } }];
    },
    [ids],
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
    setMarker(null);
  }, []);

  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      const next = markerFrom(event.collisions, event.active.id, cards);
      setMarker((prev) => (sameMarker(prev, next) ? prev : next));
    },
    [cards],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const drop = markerFrom(event.collisions, event.active.id, cards);
      setActiveId(null);
      setMarker(null);
      if (drop) onLayoutChange(moveCard(cards, String(event.active.id), drop.id, drop.side));
    },
    [cards, onLayoutChange],
  );

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    setMarker(null);
  }, []);

  const update = (cardId: string, change: (card: CardEntry) => CardEntry) =>
    onLayoutChange(cards.map((c) => (c.id === cardId ? change(c) : c)));

  const activeCard = activeId !== null ? cards.find((c) => c.id === activeId) : undefined;
  const activeChrome = activeCard ? cardChrome(activeCard) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragOver={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <SortableContext items={ids} strategy={holdInPlace}>
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
              dropMarker={marker?.id === card.id ? marker : null}
              onRemove={() => onRemove(card.id)}
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
      {/* A label, not the card: a whole chart following the pointer hid the
          cards it was being dropped on. Sized to its text rather than to the
          card, and dropped without an animation back to its old place. */}
      <DragOverlay dropAnimation={null} style={{ width: "auto", height: "auto" }}>
        {activeChrome && (
          <div className="flex max-w-64 cursor-grabbing items-center gap-2 rounded-md border border-primary/60 bg-popover px-2.5 py-1.5 text-sm font-medium shadow-lg">
            <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <activeChrome.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{activeChrome.label}</span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
