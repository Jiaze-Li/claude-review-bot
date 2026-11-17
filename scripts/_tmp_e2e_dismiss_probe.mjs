// Temporary file for AC-08 E2E verification of verified-dismiss; PR will be closed without merging.

export function crashOnNull(items) {
  if (items == null) {
    return 0;
  }
  return items.length;
}

export function safeNullProtoAssign(userKey, value) {
  const dict = Object.create(null);
  dict[userKey] = value;
  return dict;
}
