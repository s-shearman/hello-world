# .claude/commands/design-feature.md
Phase 1 design gate. Produces design artifacts before any implementation.

Pre-flight: if the work touches Phase 0 triggers (pricing, cross-product events, third-party integration, auth/security) and no ADR exists for the strategic call, run `/csuite` first.

Form: `brainstorming` drives discovery before agents write anything.

Spawn: Lead=product-owner,
       + system-architect,
       + data-architect (if schema change),
       + ux-researcher (PITCH/FORGE/PULSE) OR client-ux (LENS) OR both for cross-product UI,
       + relevant domain SME.
Task: Design $ARGUMENTS

Output:
- ADR in `docs/decisions/ADR-NNN-...md`
- Schema note in `docs/decisions/DATA-NNN-...md` if schema change
- UX spec in `docs/ux/UX-NNN-...md`
- Acceptance criteria (in ADR or UX spec)

Visual layer (UI features only): pick ONE situationally — `frontend-design` | `ui-ux-pro-max` | `impeccable`. Don't run multiple.

Do not write implementation code during this command.
