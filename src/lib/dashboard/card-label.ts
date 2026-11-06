import { CUSTOM_CARD_DEFINITION, getCardDefinition, isCustomCardId, type CardEntry } from "./card-registry";
import { customCardTitle } from "./custom-dimensions";

/** A card's name as the layout editor shows it (its drag label, the undo notice). */
export function cardLabel(card: Pick<CardEntry, "id" | "config">): string {
  if (isCustomCardId(card.id)) return card.config ? customCardTitle(card.config) : CUSTOM_CARD_DEFINITION.label;
  return getCardDefinition(card.id)?.label ?? "Card";
}
