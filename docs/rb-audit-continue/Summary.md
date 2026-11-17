# RB-AUDIT-CONTINUE-01 — what changed

After the fix-verification passes and only the final full review is left, the bot starts that review itself, even when an earlier commit left a "some files not reviewed" note behind. That note is now ignored once it is older than the commit under review (a note with no commit mark is still honoured, so a truly unreviewed file is never treated as reviewed).

When the final review cannot start by itself (chain limit, bookkeeping-only run, failed dispatch), the session comment says it is **not running** now, why, and that `@gemini review` starts it, and the commit status turns red ("Final review is NOT running"). When it was started, the comment says so and the status stays yellow. Every other status is unchanged.

Not changed: budgets, models, shard size, verification rounds, the 3-run chain limit, READY rules, session fields, session writers.
