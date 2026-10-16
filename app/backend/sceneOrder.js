// Moving a scene inside a scene list: every position that points at a scene (written versions, redo copies, shoot-schedule
// references) is renumbered with the same rule, so a scene keeps its screenplay wherever it is dropped.

// where the scene that is at position i ends up when the scene at `from` is moved to position `to`
export function moveIndex(i, from, to) {
  if (i === from) return to;
  if (from < to && i > from && i <= to) return i - 1;
  if (from > to && i >= to && i < from) return i + 1;
  return i;
}

export function moveInArray(list, from, to) {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

// SQL CASE that renumbers scene_index for a move (only positions between from and to change)
export function moveCaseSql(from, to) {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const step = from < to ? -1 : 1;
  return { lo, hi, sql: `CASE WHEN scene_index = ${Number(from)} THEN ${Number(to)} ELSE scene_index + (${step}) END` };
}

export const validMove = (count, from, to) => Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to >= 0 && from < count && to < count && from !== to;
