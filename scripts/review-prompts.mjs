// Review prompt parts that every reviewer shares, whatever model or route runs it.

// A PR the deterministic risk classifier marks as touching shared durable state gets an explicit
// concurrency procedure on top of the ordinary bug search. Empty for every other PR.
export function stateIntegrityProcedure(riskProfile) {
  if (riskProfile?.stateIntegrity !== true) return '';
  return `

This PR is deterministically classified as STATE-INTEGRITY RISK.
Perform an explicit shared-state concurrency audit in addition to the ordinary material-bug audit.

Required procedure:
1. Identify each changed durable/shared-state write sink and the lock/transaction protecting that sink.
2. Trace BACKWARD from every write sink into its changed callers. Find where the full state value or snapshot being written was originally read, copied, validated, and mutated.
3. Do not stop at a locked helper. A lock around the final write is NOT sufficient if the value written was read or mutated before entering that lock.
4. For every path where a snapshot is prepared before lock acquisition, construct this two-actor interleaving explicitly:
   - actor A reads snapshot S;
   - actor B reads the same snapshot S;
   - A mutates S -> A', acquires the lock, writes A', releases;
   - B mutates its stale S -> B', later acquires the lock and writes B'.
   Decide whether B can still succeed and silently overwrite A'. If yes, that is a lost-update bug even though the writes themselves are serialized.
5. Also check TOCTOU, stale validation, compare-and-swap/version preconditions, retry behavior, and same-resource concurrent writes.
6. Inspect changed callers and callees together across files. Do not infer safety merely because a lower-level commit/write helper uses a lock.
7. If two actors can both report success while one actor's accepted Current/History/state is lost, report it as a material correctness finding.

Deterministic signals: ${JSON.stringify(riskProfile.signals || {})}
`;
}
