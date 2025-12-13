import {itemCards } from "@/data/ItemCards"
import { ItemCard} from "@/types/ItemCard"

export const itemCardById: Record<string, ItemCard> = Object.fromEntries(
    itemCards.map(itemCard => [itemCard.id, itemCard])
)