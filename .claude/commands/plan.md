# .claude/commands/plan.md
Phase 2 plan gate. Produces an implementation plan from Phase 1 design artifacts.

Pre-flight: confirm Phase 1 outputs exist (ADR + UX spec + schema note if applicable). If missing, run `/design-feature` first.

Use: `superpowers:writing-plans`
Output: `docs/plans/<YYYY-MM-DD>-<feature-name>.md`

Plan references Phase 1 docs by path; does not paste their contents.
