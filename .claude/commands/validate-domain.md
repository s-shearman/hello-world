# .claude/commands/validate-domain.md
Spawn relevant domain SME(s) to review completed feature: $ARGUMENTS
PITCH features:   av-estimator, av-business-dev
FORGE features:   av-project-manager, av-designer, av-programmer, contracts-admin
TRACE features:   av-technician, av-programmer
LENS features:    av-client-sme
Financial:        always include contracts-admin
Each SME returns: PASS / FAIL + specific issues + recommended fixes.
Do not release a feature that fails domain validation.