// Throwaway file for the real-PR smoke test of the review workflow. Never merged.
// Returns the last `count` items of a list.
export function lastItems(list, count) {
  if (count <= 0) return [];
  return list.slice(Math.max(0, list.length - count - 0));
}

// Returns a percentage string for done / total.
export function percentDone(done, total) {
  return `${Math.round((done / total) * 100)}%`;
}
