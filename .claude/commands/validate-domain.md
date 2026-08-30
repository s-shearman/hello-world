# .claude/commands/validate-domain.md
Spawn relevant domain SME(s) to review completed work: $ARGUMENTS

Route by what the work touches:

Cost rates, labour categories, sell rates, margin   av-estimator
Capacity, utilisation, non-billable time            av-technician, av-project-manager
Efficiency ratings and job types                    av-designer, av-programmer, av-estimator
Project register, admin charge, variations          av-project-manager, contracts-admin
Channel assumptions and hours sold                  av-business-dev
Payroll tax, deemed wages, supplier engagements     contracts-admin (flags only, never determines)

Anything with a financial output always includes contracts-admin.

Each SME returns: PASS / FAIL + specific issues + recommended fixes.
Do not release work that fails domain validation.

No SME gives a tax determination. They flag; a registered tax agent decides.
