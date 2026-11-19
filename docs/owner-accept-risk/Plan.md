# Plan: Let the owner accept a P3 finding as a known risk

Stage: Plan (no code yet). Owner decision: Jack, 2026-11-19. policy_sha: `7f01e5a3ff53ed13ba763d684a098c0989425ec4`.

## Real problem
When the review bot reports a real but minor problem, the owner can decide to live with it. Today the bot has no way to say "I know about this, I accept it." The only dismissal path asks the owner to prove the finding is a false positive or already impossible. An honest answer such as "it is real, the cost is small, I accept it" is judged as "the finding still holds" and refused. The pull request then stays blocked, and the final audit never runs, until the owner either rewrites the code or releases the whole review at once.

Seen on SpinLab #220 (2026-11-19): both of the owner's explanations for F002 and F006 were refused for exactly this reason.

## Who uses it, cost of failing once
The owner (the repository owner who triggers reviews). If it fails, a minor, knowingly accepted finding blocks a pull request, or the owner is pushed into releasing the whole review, which also lets unrelated findings through.

## Goal
A third way to clear a finding, next to the existing two ("false positive" and "already impossible on this exact commit"): the owner states that the finding is real and that they accept the risk. The bot checks that what the owner accepted is really the thing it reported, and then lets it through.

## Hard boundaries
- The two existing ways to clear a finding behave exactly as before.
- Only the repository owner can accept a risk. A comment from anyone else has no effect.
- Only minor findings (P3) can be accepted. Anything more serious is refused with a plain message and no model call.
- The bot may check that the owner's description matches the reported finding (to catch a misunderstanding), but it does not judge whether the risk is worth accepting. That choice stays with the owner.
- Every acceptance leaves a visible record on the pull request: who accepted, which finding, the owner's own words, when. The final audit can see it.
- Budget, model, permissions and the whole-review release (`override review`) are untouched.

## Not doing
- Accepting findings above P3.
- Changing how findings are found, graded or verified.
- Letting an acceptance carry over silently to a new commit that changes the finding materially.
- Merging, deploying, or changing the existing "false positive" rules.

## Acceptance (observable)
1. The owner accepts an open P3 finding with a clear statement; the bot confirms, records it visibly, and the finding no longer blocks.
2. A statement that does not match the reported finding (wrong risk) is refused, and the reply says where it differs.
3. A statement that is too vague to tell what was accepted is refused.
4. Accepting a P2 or higher finding is refused with a plain message.
5. A comment from someone other than the owner has no effect.
6. The existing "false positive" and "already impossible" paths and their tests behave as before; all existing tests pass.
7. The acceptance appears in the review record and in the summary, and the final audit still runs once every other finding is resolved.
8. Real check on a live pull request after merge and deployment: NOT RUN until Jack triggers it.

## Confirmed decisions (Jack, 2026-11-19)
- Add a third path next to the existing two, rather than changing the existing rules.
- P3 only.
- The bot may check the owner's statement, to catch a misunderstanding of the reported risk.

## Open points for Design (not decided here)
- The exact way the owner writes it. Candidate idea from the owner's own attempt: a separate `@gemini accept F###` command, kept apart from `dismiss` so records show which kind of clearing happened. Design to confirm.
- What the owner must write, minimum (what risk, what consequence).
- Whether an acceptance survives a later push that changes the finding.
- The command is recognised in the entry worker, so the change needs a separate deployment; that deployment is not authorised by this Plan.

## Authorization
Plan only. Authorised now: create this branch, write this Plan, commit, push, open a draft pull request. Not authorised: Design, code, merge, deployment. Each of those starts only on Jack's explicit word.

## Risks
- Accepted P3 findings can accumulate; the visible record is what keeps that honest.
- The statement check is a model judgment and can be wrong in either direction; a refusal tells the owner why so they can reword.
