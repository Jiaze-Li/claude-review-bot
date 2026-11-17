// Temporary file for AC-08 E2E verification of verified-dismiss; PR will be closed without merging.

export function crashOnNull(items) {
  if (items == null) {
    return items.length;
  }
  return items.length;
}

export function safeLookup(map, key) {
  if (!(map instanceof Map)) return null;
  if (!map.has(key)) return null;
  return map.get(key);
}
