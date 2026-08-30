# .claude/commands/design-feature.md
Phase 1 design gate. Produces design artifacts before any implementation.

Pre-flight: if the work touches Phase 0 triggers (pricing, cross-product events, third-party integration, auth/security) and no ADR exists for the strategic call, run `/csuite` first.

Form: `brainstorming` drives discovery before agents write anything.

Spawn: Lead=product-owner,
       + system-architect,
       + data-architect (if schema change),
       + ux-researcher (operator-facing views) OR client-ux (executive-facing views)
         OR both where the same figure appears in each,
       + relevant domain SME.
Task: Design $ARGUMENTS

Output:
- ADR in `docs/decisions/ADR-NNN-...md`
- Schema note in `docs/decisions/DATA-NNN-...md` if schema change
- UX spec in `docs/ux/UX-NNN-...md`
- Acceptance criteria (in ADR or UX spec)

Do not write implementation code during this command.
