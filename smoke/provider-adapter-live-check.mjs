// Disposable fixture for a live Claude Provider Adapter smoke test.
// This branch and PR are for validation only and must not be merged.
export function normalizeSmokeLabel(input) {
  if (typeof input !== 'string') return null;
  const normalized = input.trim();
  return normalized.length > 0 ? normalized : null;
}
