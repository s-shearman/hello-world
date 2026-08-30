# .claude/commands/csuite.md
Phase 0 strategy gate. Use when the question touches pricing, cross-product events, third-party integration choice, or auth/security.

Spawn: Lead=ceo, Teammates=cto, cpo, cfo
Question: $ARGUMENTS

Process:
1. CEO frames the question (≤100 words).
2. Each advisor returns a 3-point brief, ≤150 words. Advisors reference existing ADRs/docs by path; don't restate context.
3. CEO makes the call.
4. Write ADR to `docs/decisions/ADR-NNN-<topic>.md` per CLAUDE.md format.
