import { CollectionItem } from "./types";

/** Prefer items not shown recently; never-shown first, then oldest lastShownAt. */
export function pickPiece(
  items: CollectionItem[],
  excludeIds: string[] = [],
): CollectionItem | null {
  const pool = items.filter((i) => !excludeIds.includes(i.id));
  if (pool.length === 0) return null;

  const scored = pool.map((item) => {
    const never = item.lastShownAt == null;
    const age = item.lastShownAt
      ? Date.now() - new Date(item.lastShownAt).getTime()
      : Number.MAX_SAFE_INTEGER;
    return { item, never, age, rand: Math.random() };
  });

  scored.sort((a, b) => {
    if (a.never !== b.never) return a.never ? -1 : 1;
    if (a.age !== b.age) return b.age - a.age;
    return a.rand - b.rand;
  });

  // Weighted pick among top half for a bit of surprise
  const top = scored.slice(0, Math.max(1, Math.ceil(scored.length / 2)));
  const choice = top[Math.floor(Math.random() * top.length)];
  return choice.item;
}
