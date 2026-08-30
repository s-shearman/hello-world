# Workforce Cost, Capacity and Payroll Tax Model — Schema Proposal

**Status:** for review. No application code written yet.
**Date:** 2026-08-29

> **Disclaimer.** This tool produces indicative figures to inform a conversation with
> your accountant. It is not tax advice and does not replace review by a registered
> tax agent. Payroll tax grouping, contractor and employment agency provisions turn on
> facts and evidence specific to each arrangement.

---

## 1. What I have assumed

Confirmed by you:

| | |
|---|---|
| **Legal structure** | One company, four offices (NSW, VIC, QLD, WA) |
| **Engagement mix** | Labour hire firms supplying workers; sole trader subbies direct; subcontract companies delivering an outcome; crews that cross state lines |
| **Efficiency measurement** | Delivery judgement today, no formal measure |
| **Deployment** | Node + Postgres, shared across the business |

Assumed by me unless you say otherwise — each of these is cheap to change now and
expensive later, so please push back:

1. **Financial year.** FY2026–27 (1 Jul 2026 – 30 Jun 2027) is the working year, with
   FY2025–26 retained so year-on-year comparisons and prior-year returns still work.
   Every rate and threshold is keyed by financial year, so this is data, not a decision
   baked into code.
2. **All figures are ex-GST.** GST is not modelled anywhere. Charge-out rates from
   suppliers are stored ex-GST and the importer will require you to confirm which the
   source file contains.
3. **Standard week is 38 hours**, as a configurable default, overridable per person.
4. **Monthly buckets** are the default period grain for capacity and burn-down, with a
   weekly option. The demand interface accepts arbitrary date ranges regardless.
5. **You may occasionally pay wages outside the four states.** The model covers all
   eight jurisdictions because Australia-wide wages drive threshold apportionment, so
   even a small SA or ACT wage bill changes your NSW answer.

---

## 2. Architecture

### 2.1 Why this shape

You chose Postgres and shared access, which is the right call given four offices need
the same numbers, and because scenario decisions want an audit trail. Three things
follow from it:

**The calculation engine is a pure library with no database imports.** It takes a
fully-materialised input snapshot and returns results plus a trace. The same compiled
package runs on the server for authoritative runs and *in the browser* for what-if
editing. That is how you get "change an input and see the effect immediately" without
a round trip per keystroke, and it means the number you see while dragging a slider is
produced by the same code as the number in the saved scenario.

**The tax rules layer is a versioned, source-annotated data file, not code.** Rules
change every July. The engine reads a ruleset; it never contains a rate. See §6.

**Every stored fact that can change over time is effective-dated** rather than updated
in place. Salaries change mid-year, people move between offices, efficiency ratings get
revised, thresholds change on 1 July. Part-year apportionment is only correct if the
history is intact.

### 2.2 Stack

| Layer | Choice | Reason |
|---|---|---|
| Database | Postgres 16 | Shared, transactional, good at the temporal and aggregate queries this needs |
| Migrations / ORM | Drizzle | Migrations are readable SQL, types generated from schema |
| API | Fastify + TypeScript, OpenAPI generated | The demand app needs a documented contract to write against |
| Calc engine | `@wf/calc` — pure TypeScript, zero I/O | Runs server-side and in-browser; unit-testable in isolation |
| Tax rules | `@wf/tax-rules` — versioned JSON + rule functions | Swappable per financial year, diffable in git |
| Web | React + Vite + TanStack Query/Router | — |
| Money | `bigint` cents throughout | No floating point on money, ever |
| Tests | Vitest, golden-file tests | Worked examples from revenue office guidance become regression tests |

### 2.3 Repository layout

```
packages/
  tax-rules/      rulesets/FY2026-27/{NSW,VIC,QLD,WA,SA,TAS,ACT,NT}.json
                  rules/{threshold,grouping,contractor,employment-agency,nexus}.ts
  calc/           cost.ts capacity.ts efficiency.ts ratecard.ts overhead.ts
                  marginal-tax.ts scenario.ts trace.ts
  schema/         Drizzle schema + migrations, shared types
apps/
  api/            Fastify, REST + OpenAPI, CSV import, demand ingest endpoint
  web/            React app
```

### 2.4 Access control — flagging this now

Fully loaded cost per person means salary data for the whole business sits in one
database that four offices reach. I propose three roles from day one, because
retrofitting this is painful:

- **Admin** — everything, including remuneration and tax config.
- **Delivery** — capacity, hours sold, efficiency, role-level rates. Sees role-average
  cost rates, not individual salaries.
- **Finance** — everything except user administration.

Individual remuneration lives behind a `sensitive` column policy so the capacity
dashboards work for a PM without exposing pay. Tell me if you want this differently.

---

## 3. Layer 1 — Entity and group

You are a single company today. I am still modelling the full entity graph, because AV
integrators routinely add a second entity (a labour co, a service co, an acquisition),
and grouping provisions are the single most expensive thing to retrofit — the whole
threshold calculation changes shape when a group appears.

```
legal_entity
  id, legal_name, abn, acn, entity_type            company | trust | partnership | sole_trader
  is_employer, active_from, active_to

entity_relationship                                 -- drives grouping analysis
  from_entity_id, to_entity_id
  relationship_type       ownership | controlling_interest | common_directors
                          | shared_employees | tracing_interest
  ownership_pct, evidence_note, valid_from, valid_to

payroll_tax_group
  id, financial_year, jurisdiction_code             -- NULL = applies in all jurisdictions
  designated_group_employer_entity_id
  determination_note

group_membership
  group_id, entity_id, jurisdiction_code
  status                  member | excluded
  exclusion_order_ref, exclusion_granted_date, exclusion_expires

payroll_tax_registration
  entity_id, jurisdiction_code, registered, registration_number, registered_from

wage_declaration_override                          -- wages paid outside this system
  entity_id, jurisdiction_code, financial_year, taxable_wages_cents, source_note
```

Two deliberate choices:

- **Grouping is recorded per jurisdiction.** Each state decides grouping under its own
  Act and can grant an exclusion the others refuse. A single `is_grouped` boolean would
  be wrong the day it matters.
- **Australia-wide taxable wages are derived**, not stored, by summing the wage ledger
  across all jurisdictions and entities in the group — plus `wage_declaration_override`
  for any wages paid outside the tool. Storing a total invites it going stale.

---

## 4. Layer 2 — Office and state

```
jurisdiction                                        -- reference: NSW VIC QLD WA SA TAS ACT NT
  code, name

office
  id, entity_id, name, jurisdiction_code
  opened_on, closed_on, is_default_for_jurisdiction

public_holiday_calendar                             -- jurisdiction-specific, config
  jurisdiction_code, financial_year, date, name, source_ref
```

There is deliberately **no** `office.taxable_wages` or `office.headcount` column. Both
are derived, from the wage ledger and from `person_assignment` respectively. A stored
copy is a copy that drifts.

**Days employed per state** likewise falls out of `person_assignment` (§5), which is
effective-dated with a jurisdiction. Part-year apportionment then reads the real
history: someone who started in October or moved from the Brisbane office to Perth in
March apportions correctly without anyone maintaining a days field.

### 4.1 Nexus — where a wage is taxed

You told me crews cross state lines, which makes this load-bearing rather than an edge
case. Wages for a month are sourced to **one** jurisdiction by a defined hierarchy
(the harmonised rule considers, in order, where the employee's services were mainly
performed, the employee's principal place of residence, the employer's registered ABN
address, and the place of payment). The exact ordering and tests come from the ruleset,
not from code:

```
wage_nexus_determination
  person_id, financial_year, period_start, period_end
  jurisdiction_code                                 -- resolved answer
  rule_applied, rule_ref                            -- which limb of the hierarchy decided it
  inputs_snapshot jsonb                             -- what it was decided on
  is_override, override_reason, determined_at
```

Every month of every person's wages carries a determination that says *why* it landed
in that state. Where the tool cannot decide, it flags rather than guesses, because
guessing quietly moves wages between thresholds.

---

## 5. Layer 3 — People and roles

### 5.1 Roles are data

```
role_family                                         -- you can add rows, no code change
  id, code, label, display_order
  -- seeded: technician, commissioning_engineering, project_management, sales_design,
  --         procurement, warehouse_logistics, finance_admin

role
  id, role_family_id, name, level_label, level_ordinal    -- 'Junior' / 'Intermediate' / 'Senior'
  default_billability          billable | partial | overhead
  default_partial_billable_pct
  default_target_utilisation_pct
  default_efficiency_pct
  default_contracted_hours_per_week
  active, notes
```

Adding "Senior Commissioning Engineer" or "Service Coordinator" is a row. Nothing in
the engine switches on a role name.

### 5.2 People

```
person
  id, external_ref, display_name
  employer_entity_id                                -- NULL when supplied by a supplier
  supplier_id                                       -- NULL when employed
  engagement_type_id
  status, start_date, end_date

engagement_type                                     -- lookup, extendable
  id, code, label
  is_employee                                       -- drives default wage treatment
  is_supplied_labour
  -- seeded: full_time, part_time, casual, sole_trader_contractor, labour_hire_supplied

person_assignment                                   -- EFFECTIVE-DATED. The workhorse.
  person_id, role_id, office_id, jurisdiction_code
  fte, contracted_hours_per_week
  valid_from, valid_to
  -- gives: headcount by office/role, days employed per state, part-year apportionment,
  --        interstate moves, role changes mid-year

person_remuneration                                 -- EFFECTIVE-DATED
  person_id, basis                                  annual_salary | hourly_rate | daily_rate
  amount_cents, casual_loading_pct
  valid_from, valid_to

person_billability                                  -- EFFECTIVE-DATED
  person_id, billability, partial_billable_pct, target_utilisation_pct
  valid_from, valid_to
```

### 5.3 Allowances and on-costs — the defaults-and-overrides pattern

Your requirement was that every allowance is individually toggleable, editable, and has
a sensible default you can override per person. That is three tables, not a wide table
of nullable columns:

```
cost_component_type                                 -- what kinds of cost exist. Extendable.
  id, code, label, category                         allowance | on_cost | statutory
  calc_basis        fixed_annual | fixed_monthly | per_hour | per_km
                    | pct_of_base | pct_of_base_plus_allowances
  counts_as_taxable_wages_default                   -- ! see below
  counts_toward_super_ote
  display_order, notes
  -- seeded: tool_allowance, vehicle_novated, vehicle_company, vehicle_allowance,
  --   fuel_tolls, phone_data, laptop_software, training_certification, ppe_uniforms,
  --   professional_memberships, travel_accommodation_loading, overtime_penalty_loading,
  --   workers_compensation, superannuation, leave_loading

cost_component_default                              -- the default layer, scoped
  cost_component_type_id
  scope             global | role_family | role | office | jurisdiction | engagement_type
  scope_ref_id
  enabled, value_cents_or_pct
  valid_from, valid_to, source_note

person_cost_component                               -- the per-person override
  person_id, cost_component_type_id
  enabled, value_cents_or_pct
  override_reason, valid_from, valid_to
```

**Resolution precedence**, applied in order, first match wins, and recorded in the
trace so you can always see which layer supplied a number:

```
person → engagement_type → role → role_family → office → jurisdiction → global
```

**The `counts_as_taxable_wages` flag matters more than it looks.** Superannuation is
taxable wages for payroll tax. Several allowances are exempt, some only up to a limit
(motor vehicle allowances up to a per-kilometre rate, accommodation allowances up to a
capped daily amount), and the limits differ by jurisdiction and change annually. So the
flag on the component type is only the default — the authoritative treatment comes from
the ruleset:

```
tax-rules: wage_inclusion_rule
  jurisdiction, component_code
  treatment        included | excluded | excluded_up_to_limit
  limit_value, limit_basis, source_url, retrieved_date
```

This is why on-costs can't be a simple percentage loading. A 20% loading is fine for
costing and wrong for tax.

### 5.4 Non-billable time

Same defaults-and-overrides pattern, because public holidays differ by state and
training load differs by role:

```
time_deduction_type                                 -- extendable
  id, code, label, unit                             days | hours | pct_of_contracted
  -- seeded: annual_leave, personal_leave, public_holidays, training,
  --         internal_meetings, travel_between_sites, other_non_billable

time_deduction_default
  time_deduction_type_id, scope, scope_ref_id, value, valid_from, valid_to

person_time_deduction
  person_id, time_deduction_type_id, value, override_reason, valid_from, valid_to
```

Public holidays default from `public_holiday_calendar` for the person's jurisdiction,
so a Perth tech and a Melbourne tech get different counts without you entering either.

---

### 5.5 Shared and multi-state roles

You raised procurement: based in VIC, serving all four states. This is two different
questions wearing one hat, and they must not share a field.

**For payroll tax: no split.** Wages are taxed by the state in which they are taken to
have been paid, resolved by the nexus provisions in §4.1 — one jurisdiction per person
per month, decided by where the services were performed and the remaining limbs of that
hierarchy. It is *not* apportioned by which offices benefit from the work. A procurement
manager sitting in Melbourne buying gear for a Perth job is VIC wages. That four states
benefit is irrelevant to the assessment.

The exception turns on **performance, not benefit**: if that person actually spends a
month working in WA, the nexus test can land the month in WA. That is a determination
about where they were and what they did, not about who the work was for — and it is
exactly the kind of question to put in front of your accountant. The schema copes
because determinations are per person per period, so one month can differ from the
months around it.

**For internal performance: yes, split.** Otherwise VIC carries the entire procurement
cost and looks structurally unprofitable, while NSW, QLD and WA look better than they
are. That distortion is the whole reason the question is worth asking.

Two mechanisms, deliberately unconnected:

| Question | Mechanism | Answer for VIC procurement |
|---|---|---|
| Which state taxes the wage? | `wage_nexus_determination` (§4.1) | **VIC, 100%. No split.** |
| Which offices bear the cost? | `cost_allocation` (below) | Spread across all four |
| How does that cost reach a rate? | `overhead_policy` (§11.7) | Per office, after allocation |

#### The allocation tables

```
allocation_driver                                   -- lookup, extendable
  code, label, basis
  -- seeded: fixed_pct, office_headcount, office_billable_hours,
  --         office_revenue, office_hours_sold, delivered_hours_actual

cost_allocation                                     -- EFFECTIVE-DATED
  subject_type      person | expense | expense_category
  subject_id                                        -- one engine, any cost subject
  driver_code
  scope             single_office | listed_offices | all_offices
  valid_from, valid_to, note

cost_allocation_target
  cost_allocation_id, office_id
  pct                                               -- only when driver = fixed_pct
```

The same engine allocates operating expenses (Layer 5), which is why `subject_type`
exists rather than a second, parallel set of tables.

**Everyone carries an allocation, and the ordinary case is the degenerate one.** A Perth
technician is `fixed_pct / single_office / 100% Perth`. Nothing about the normal case
changes — a shared role is the same mechanism with different parameters, not a special
case bolted on beside it. Your VIC procurement manager is `office_headcount /
all_offices`, and the split recomputes each period as headcount moves; or `fixed_pct` if
you would rather it stayed still and was argued about once a year.

Two invariants the database enforces:

- Allocations for a person in any period **sum to exactly 100%**. Cost cannot silently
  vanish or be counted twice.
- A reconciliation report proves `total person cost == Σ allocated cost across offices`
  for every period. This is what catches the bug where someone edits an office's dates
  and 4% of a salary quietly disappears.

#### Billable people who work across states

The same mechanism covers a VIC commissioning engineer who flies to Perth, with a
different driver: `delivered_hours_actual`, so their cost follows the hours they actually
delivered per office rather than a fixed guess. But their **capacity** also has to appear
in more than one pool:

```
person_capacity_scope                               -- which offices can draw on this person
  person_id, office_id
  max_pct_of_capacity                               -- optional cap, e.g. WA draws at most 25%
  valid_from, valid_to
```

Without this, the Perth capacity dashboard reports a shortfall it does not have, and the
tool tells you to hire someone you already employ.

#### The honest caveat

There is no objectively correct allocation driver. Headcount, revenue and hours-sold give
different answers, and the gap between them is routinely wide enough to flip which state
looks like it is performing. So the office view computes the result under **every** driver
and shows the spread, with one marked as your reporting default. If NSW is profitable
under headcount and unprofitable under revenue share, you want to know that before you
act on either number — the sensitivity *is* the finding.

---

## 6. Layer 4 — Supplier and engagement

```
supplier
  id, legal_name, abn, entity_type                  sole_trader | company | partnership | trust
  engages_own_staff
  provides_own_supervision
  gst_registered, active, notes

supplier_arrangement                                -- EFFECTIVE-DATED, per jurisdiction
  supplier_id, jurisdiction_code
  arrangement_class    employment_agency | labour_hire | relevant_contract
                       | supply_with_materials | out_of_scope
  liable_party         us | supplier | client | unclear
  declaration_held, declaration_ref, declaration_date
  assessed_by, assessed_date, basis_note

engagement                                          -- a supplier + role + office arrangement
  id, supplier_id, office_id, jurisdiction_code
  person_id                                         -- the supplied worker, where known
  role_id, job_type_id
  labour_basis         labour_only | labour_plus_materials
  materials_basis      pct | amount | itemised
  materials_value
  ordinarily_required_by_business                   -- feeds one of the exemption tests
  rate_basis           hourly | daily | fixed
  charge_out_rate_cents
  start_date, end_date, project_ref

engagement_line                                     -- period-level actuals / forecast
  engagement_id, period_start, period_end, jurisdiction_code
  hours, amount_cents, materials_amount_cents
  efficiency_pct                                    -- per-line override (see §7)
  notes

engagement_day                                      -- ! one row per calendar day worked
  engagement_id, work_date
```

### 6.1 Why `engagement_day` exists

The days tests for contractor exemptions count **distinct days a supplier performed
services for you across the whole financial year**, not days per project. Two crews
from the same firm on two jobs on the same Tuesday is one day, not two. Storing a
`days_worked` integer per engagement would double-count and quietly push a supplier
past the limit — or hide that they already have.

So the register aggregates `COUNT(DISTINCT work_date)` per supplier per financial year
per jurisdiction. The CSV importer expands date ranges into day rows, and asks about
weekends and non-working days rather than assuming.

### 6.2 Exemptions — deemed by default, exempt only on evidence

```
contractor_exemption_claim
  supplier_id, engagement_id                        -- claim can sit at either level
  financial_year, jurisdiction_code
  exemption_code                                    -- FK to ruleset exemption catalogue
  claimed, evidenced
  evidence_ref, evidence_date
  reviewed_by, review_date, review_due
  determination_note
```

Rules the engine enforces:

- Contractor payments are **deemed wages by default**. Nothing is excluded silently.
- An exemption applies only when `claimed AND evidenced`. Claimed-but-unevidenced shows
  as deemed, with a visible "claim not evidenced" flag and the dollar value at risk.
- The applied exemption code and its source reference appear in every output that
  excludes a payment. You should never see an amount drop out without being told why.
- **Employment agency and labour hire arrangements are assessed first**, on a separate
  path from the general contractor provisions, because they can make a payment taxable
  regardless of whether a contractor exemption would otherwise have applied. Where
  `arrangement_class` is `employment_agency` or `labour_hire`, the register shows the
  liable party and does not offer contractor exemptions as a way out.

The exemption catalogue itself (the tests, their day limits and percentage thresholds)
lives in the ruleset with a source URL per entry — see §7 — so I am not writing day
counts into the schema from memory.

---

## Layer 5 — Operating expenses and overheads

Everything above costs money because someone is paid. This layer covers the rest: rent,
vehicles, software, insurance, warehouse operations. Held at planning grain, not
general-ledger grain.

**Scope boundary, the same shape as the demand tool.** This is not accounting. Xero, or
whatever you run, stays the source of truth for what was actually spent. This layer holds
the annualised, categorised figures needed to build a cost rate and an office result, with
an optional trial-balance mapping later so the numbers reconcile rather than get retyped.

### L5.1 The line between a cost component and an expense

The most valuable rule in this layer, because getting it wrong double-counts:

> **If it attaches to a person, it is a cost component (Layer 3).
> If it attaches to the business, it is an expense (Layer 5).**

A vehicle allowance paid to a named technician is a cost component. Six utes on lease is
an expense. A laptop issued to someone is a cost component; the ERP site licence is an
expense. The tool warns when both sides are populated for the same thing — a person
carrying a `vehicle_*` component while the fleet category also has per-head steps —
because that is exactly how you end up paying for the same ute twice.

### L5.2 Tables

```
expense_category                                    -- extendable, hierarchical
  id, parent_id, code, label
  behaviour          fixed | variable_with_headcount
                     | variable_with_hours | step_fixed
  default_driver_code                               -- default allocation driver
  display_order, notes
  -- seeded groups:
  --   property        office_rent, warehouse_rent, outgoings, utilities,
  --                   cleaning, security, make_good
  --   fleet           vehicle_lease, registration, insurance, maintenance,
  --                   fuel_card, tolls
  --   technology      erp_licences, design_software, m365, telephony,
  --                   network, hardware_refresh
  --   insurance       public_liability, professional_indemnity,
  --                   business_pack, cyber
  --   professional    accounting, legal, audit, consulting
  --   warehouse_ops   racking, forklift, consumables, freight_inwards,
  --                   stocktake, waste
  --   tooling         test_equipment, calibration, tool_replacement
  --   compliance      licences, memberships, certifications
  --   sales_marketing marketing, tender_costs, non_project_travel
  --   finance_charges interest, bank_fees, merchant_fees, bad_debts

expense                                             -- EFFECTIVE-DATED
  id, expense_category_id, entity_id
  office_id, jurisdiction_code                      -- NULL = national / shared
  supplier_ref, description
  amount_cents, frequency   annual | monthly | quarterly | weekly | one_off
  basis                     actual | budget | forecast
  contract_start, contract_end, review_date
  escalation_pct                                    -- CPI or fixed annual review
  includes_labour_component                         -- ! routing flag, see L5.4
  valid_from, valid_to, note

expense_period                                      -- materialised per period
  expense_id, period_start, period_end
  budget_cents                                      -- set from the expense line
  actual_cents                                      -- typed in as it lands
  variance_cents, variance_note
```

`contract_end` and `review_date` are not decoration. A warehouse lease expiring in
fourteen months inside a model you are using to plan headcount is information you want
surfaced, so expiring contracts appear on the exposure view alongside tax thresholds.

### L5.3 Step costs — cut

I proposed a step-cost calculator: thresholds like *"every twelve field staff needs another
warehouse bay"*, driving overhead automatically. **Cutting it.** You run one warehouse worker
per state, positions get filled when they are needed, and you know your own step points better
than a formula would.

Correcting something I wrote when I first cut it: I said adding a warehouse and adding a
warehouse person were the same action. **They are not.** A new or small location gets premises
well before it warrants a dedicated resource. They are independent decisions with independent
triggers — property follows geography and stock, headcount follows workload — and the model has
to let them move separately. It already does: `expense` carries an `office_id` and knows nothing
about headcount.

Both are still discrete decisions rather than formula outputs, which is why `scenario_change`
(§11.6) covers them and `expense_step` is not needed. But they are two decisions, not one.

### L5.3.1 Where the work goes when there is no dedicated resource

This is why that correction is worth more than a footnote.

If a small Perth site has a warehouse but no warehouse person, the warehousing does not stop
happening. A technician picks and receives, a project coordinator chases a delivery, or the
warehouse manager in another state covers it remotely. That work is real cost, and by default
it lands in the wrong place twice over:

- it is **missing from the non-billable pool**, so the coverage test reads better than reality;
  and
- it is **hidden inside a billable person's utilisation**, so the capacity model credits that
  technician with hours they do not have.

Both errors point the same way — everything looks slightly better than it is — which is the
most dangerous kind.

```
office_function_coverage                            -- EFFECTIVE-DATED
  office_id
  function_code    warehousing | procurement | project_admin | finance
  coverage_mode    dedicated_role | absorbed_by_roles
                   | covered_from_office | outsourced | none
  covered_by_person_id, covered_by_office_id, supplier_id
  hours_per_week                                    -- the absorbed load
  valid_from, valid_to, note
```

Absorbed hours do two things at once: they come **out** of that person's billable capacity, and
they go **into** the non-billable pool, costed at that person's fully loaded rate. The function
is charged where it is actually being performed, and the technician stops appearing to have
capacity they are spending on picking.

That also makes the maturity path visible without calculating it. **"One warehouse worker per
state" is a target end-state, not an invariant.** A new location starts at `absorbed_by_roles`
and moves to `dedicated_role` when you decide it should. The tool does not decide and does not
infer a threshold — it reports the absorbed load you have entered, and shows it rising:
*"WA is absorbing 14 hours a week of warehousing across three technicians — 0.37 FTE of billable
capacity."* The decision then presents itself at roughly the right time, instead of being
noticed a year late.

### L5.4 What this layer must never touch

Expenses are not wages. They never enter taxable wages, the deemed wages register, or any
threshold calculation. There is exactly one path from this layer to the tax layer, and it
is a routing rule rather than a calculation:

**`includes_labour_component`.** A monthly IT support retainer from a sole trader, a
cleaning contract, a security contract, a labour-only freight arrangement — all look like
overheads on an invoice, and all can be relevant contracts for payroll tax. When the flag
is set, the tool **refuses to treat the line as an expense** and routes you to create a
supplier engagement in Layer 4, where the contractor provisions apply properly and the
days tests run.

The flag is raised, not decided. Whether such a contract is caught turns on the facts and
the evidence, which is a question for your accountant — but a tool that silently files it
under "rent and outgoings" guarantees nobody ever asks.

### L5.5 Allocation uses the same engine

Office rent is `fixed_pct / single_office / 100%` — it already belongs to one office. The
ERP licence, group insurance and the accountant's fee are `office_headcount / all_offices`,
or whichever driver you pick. Same engine as §5.5, same 100% invariant, same reconciliation
report, same trace. No second allocation system to keep in step with the first.

**Default driver: hours sold.** You confirmed staff-per-state follows hours sold, so
`office_hours_sold` is the reporting default for shared roles and national overheads. The
other drivers stay computed and visible alongside it — see the caveat in §5.5.

### L5.6 Budget, actual, and which one feeds a rate

You will type these in, budget and actual. So the grid is category × period, with budget
seeded from the expense line's `amount_cents` and `frequency`, and actuals entered as they
land. Variance is derived, never entered.

That leaves a real question the tool must not answer silently: **which figure builds a cost
rate?** Three bases, selectable per calculation run and recorded in the trace:

| Basis | What it is | Use it for |
|---|---|---|
| `budget` | The plan, whole year | Next year's rate card; scenarios |
| `actual` | What was actually spent | Historical office performance; the year in review |
| `blended` | Actuals to date + budget for remaining periods | **Default.** The best forward estimate mid-year |

`blended` is the default because in March neither of the other two is right: budget ignores
what has already happened, and actual-annualised over-weights a quarter that had the
insurance renewal in it. Every output states which basis it used, because a rate card built
on budget and an office result built on actual are not comparable and will be compared
anyway.

### L5.7 Recovery pools and the project admin charge

You recover non-billable staff through an admin charge applied to every project. That is a
real commercial mechanism producing real revenue, not a notional allocation — which means
the model needs both, and needs to compare them.

It also means **your overheads are not all recovered the same way**. The admin charge covers
non-billable staff. Property, fleet, technology and insurance are recovered somewhere else —
in the sell rate, or in gross margin, or not at all. So overhead is not one pool:

```
recovery_pool                                       -- extendable
  id, code, label
  recovery_method   project_admin_charge | loaded_into_sell_rate
                    | per_billable_hour | not_recovered
  charge_id                                         -- FK when project_admin_charge
  note
  -- seeded: admin_charge_pool  (non-billable roles)
  --         rate_loaded_pool   (property, fleet, technology, insurance)
  --         below_the_line     (interest, bad debts — deliberately unrecovered)

cost_pool_assignment                                -- EFFECTIVE-DATED
  subject_type   role | expense_category | person | expense
  subject_id, recovery_pool_id
  valid_from, valid_to
  -- precedence: person/expense → role/expense_category → default pool

overhead_recovery_charge                            -- the charge itself
  id, name
  basis      pct_of_project_labour | pct_of_project_value | per_project_fixed
             | per_billable_hour | tiered_by_project_value
  rate_value
  applies_to  all_projects | by_office | by_job_type | by_client
  scope_ref_id
  min_charge_cents, max_charge_cents                -- floor and cap per project
  valid_from, valid_to, note

project_admin_charge_line                           -- what was actually charged
  project_ref, office_id, period_start, period_end
  basis_amount_cents                                -- what the rate was applied to
  charge_cents, is_actual
```

#### The trap: do not recover the same overhead twice

If the admin charge sits on the project as its own line, then **the technician sell rate
must not also carry that overhead**. Loading non-billable staff cost into the hourly rate
*and* charging admin on top charges the client twice and tells you your margin is better
than it is. The same in reverse: if you strip overhead out of the rate and the admin charge
does not actually cover it, you are selling at a loss and the rate card will say you are
fine.

So every sell rate carries its convention explicitly, and the margin calculation respects
it:

```
sell_rate
  + overhead_treatment   recovered_in_rate | recovered_via_admin_charge
```

The rate card view (§11.4) then asks the right question for each rate: for
`recovered_via_admin_charge` rates, does the sell rate cover **direct** cost — person cost
plus payroll tax, no overhead? For `recovered_in_rate` rates, does it cover **fully loaded**
cost? Mixing the two conventions in one comparison is the most common way a rate card
quietly lies, and the tool refuses to do it.

---

### L5.8 Setting the admin charge — the method, and its failure modes

Your method: sum shared resource cost (warehouse manager, finance, head of projects,
procurement manager), divide by the revenue target to get a percentage, then vary it by
project type — fixed below a threshold, higher percentages for mid, large and builder work.

**The arithmetic is right and it is the right place to start.** Shared cost ÷ revenue gives
the blended rate you have to recover, and everyone in the business should know that number.
Varying by project type is also right, because shared resource consumption genuinely is not
proportional to revenue. And a fixed fee below a threshold is right for the obvious reason:
on a $3k job a percentage yields a couple of hundred dollars, which does not cover the
procurement manager touching it once.

Five things I would change or watch.

#### 1. The denominator is a target, so the charge only works if you hit it

Set the rate at target, miss the target, under-recover — and you find out at year end. I
would set the rate against a deliberately conservative revenue figure, say 90% of target,
so a normal year over-recovers slightly rather than a soft year under-recovering badly. The
tool then reports recovery at target, at forecast and at actual, and the revenue level where
recovery breaks even.

```
overhead_recovery_charge
  + denominator_basis    revenue_target | conservative_target | prior_year_actual
  + conservatism_pct     -- e.g. 90, meaning rate set on 90% of target
```

#### 2. Cost ÷ revenue recovers cost and nothing else

Set to exactly cover shared resource cost, the charge contributes zero margin. That may be
precisely what you intend — cover overhead, make margin on labour and equipment. But make it
a decision rather than an accident, so the charge splits into its two components:

```
overhead_recovery_charge
  + recovery_component_pct    -- what covers the shared cost pool
  + premium_component_pct     -- deliberate margin or risk loading on top
```

#### 3. Tier cliffs get gamed, by your own people first

A fixed fee up to $X and a percentage above it creates a cliff. A job at $X + $1 suddenly
carries a materially different charge, so jobs get split into two, or discounted to duck
under the line. Make the tiers **progressive, like a tax bracket** — fixed fee up to $X,
then a percentage on the excess above it. Smoother, much harder to game, and far easier to
defend to a client who asks why.

```
overhead_recovery_charge
  structure     flat_pct | fixed | progressive_bands

overhead_recovery_band                              -- marginal bands, not a lookup
  charge_id, band_from_cents, band_to_cents
  fixed_component_cents, pct_of_excess
  applies_to_channel                                -- builder bands can differ
```

This is the same shape as the payroll tax threshold logic in §8.3, and for the same reason:
a cliff makes the marginal decision wrong, whether the decision is a hire or a quote.

#### 4. One percentage of revenue blends drivers that are genuinely different

Your shared roles do not scale with the same thing:

| Shared role | What actually drives its workload |
|---|---|
| Warehouse manager | Equipment volume and value |
| Procurement manager | Supplier count, order lines, hardware value |
| Finance | Invoice and transaction count |
| Head of projects | Project count and complexity — not dollars |

A single percentage of revenue over-charges a labour-heavy install for a warehouse it barely
touched, and under-charges a hardware-heavy fit-out that filled the racking for three weeks.

But a four-driver charge is unquotable and nobody wants to explain it to a client. So:
**keep one simple client-facing charge, and model the multi-driver version internally as the
check.**

```
shared_cost_driver                                  -- internal consumption model
  subject_type   role | expense_category
  subject_id
  driver   equipment_value | supplier_order_lines | invoice_count
           | project_count | labour_hours | contract_value
  weight, note
```

The tool computes what each project type *should* pay on a consumption basis, compares it
with what your tiered percentage actually collects, and reports the **cross-subsidy**: which
project types are carrying which. You then set the tiers deliberately, instead of discovering
the cross-subsidy in next year's result. Simple on the outside, honest on the inside.

#### 5. Ask what the builder premium is actually for

A higher percentage on builder work is defensible if builders genuinely consume more — more
coordination, more variations, more site meetings, more reporting. It is also defensible as a
premium for worse payment terms, retention and back-charge risk. Both are real, but **they
are different charges**.

If the premium is really a risk premium, it belongs in margin, not in overhead recovery.
Otherwise your recovery position reads as healthy when what you actually hold is a risk
buffer — and you will trim the charge in a competitive tender without realising what you just
gave away. This is what `premium_component_pct` in point 2 is for: same number to the client,
two components internally.

#### And before you set any of it — backtest it

Run the proposed tiers over the last twelve months of actual projects and see what they would
have collected against what shared resource actually cost.

```
charge_backtest_run
  id, proposed_charge_id, period_start, period_end
  projects_included, would_have_collected_cents
  shared_cost_actual_cents, recovery_pct
  by_project_type jsonb, by_channel jsonb, by_office jsonb
```

That turns *"8% feels about right"* into *"this recovers 103% of last year's shared cost, and
small jobs are being subsidised by four points."* It is cheap, it is the single strongest
thing you can put in front of a board, and it needs one input the model does not yet have.

### L5.9 The project register

Tiering by project value and backtesting both need projects as records, not just a
`project_ref` string:

```
client
  id, name, abn, channel_default, payment_terms_days, notes

project
  id, project_ref, name, client_id
  office_id, jurisdiction_code, job_type_id
  channel            direct | builder | consultant | dealer | internal
  contract_value_cents
  labour_value_cents, equipment_value_cents         -- the split that drives consumption
  status, won_date, delivery_start, delivery_end
  source_system, external_id                        -- imported, not hand-maintained
```

This is a thin register, deliberately. It holds what the charge and the backtest need —
value, split, type, channel, office, dates — and nothing else. Project management stays
wherever it lives today; the `labour_value` / `equipment_value` split is the only field that
may not already exist in a form you can export, and it is the one that makes the consumption
model work.

---

## 7. Efficiency model

Since efficiency is currently delivery judgement, the schema's job is to make those
judgements explicit, attributable and refutable, and to stop them ageing silently.

```
efficiency_baseline
  financial_year, scenario_id
  baseline_role_id                                  -- default: Technician (Intermediate)
  set_by, set_date, note

job_type                                            -- extendable lookup
  id, code, label
  -- seeded: rack_build, site_install, cable_pull, commissioning,
  --         programming, service_call, site_survey

efficiency_rating
  id
  subject_type      role | supplier | supplier_job_type | person | engagement | engagement_line
  subject_id, job_type_id                           -- job_type NULL = applies to all work
  efficiency_pct                                    -- vs the baseline role at 100%
  source            judgement | derived_variance | derived_rework | supplier_stated
  confidence        low | medium | high
  basis_note                                        -- free text: why this number
  rated_by, last_reviewed_date, review_due_date
  valid_from, valid_to, superseded_by
```

**Resolution precedence**, most specific wins:

```
engagement_line → engagement → person → supplier + job_type → supplier → role → baseline (100%)
```

The trace records which rating won, its source, its confidence, its author and when it
was last reviewed. So "Firm X is 60% as a junior tech" and "on commissioning work Firm X
is 85%" coexist, and a specific crew that outperforms is a one-line override on that
engagement line without disturbing the supplier's general rating.

**Staleness is a first-class state.** `review_due_date` defaults to 6 months from
`last_reviewed_date` (configurable). Past due, the rating still applies but every output
that used it carries a stale flag, and the dashboard has a "ratings needing review"
queue. A gut-feel number that nobody has looked at in two years is the most dangerous
input in the model, so it is the one the tool nags about.

Ratings are **superseded, never edited**. Revising a rating writes a new row and points
the old one at it, so a scenario you ran in October still reproduces in March.

### 7.1 How efficiency flows

Three derived quantities, applied consistently everywhere:

| Quantity | Formula |
|---|---|
| Effective hours | `raw_hours × efficiency_pct` |
| Effective cost per hour | `actual_cost_per_hour ÷ efficiency_pct` |
| Effective capacity | `available_billable_hours × utilisation × efficiency_pct` |

Worked, using your examples: 38 raw hours at 60% is 22.8 effective hours. A contractor
at $65.00/hr at 60% costs $108.33 per delivered hour.

Every capacity and cost figure in the application is the value object
`{ raw, effective, efficiency_pct, rating_ref }` — raw and effective are carried
together, never collapsed, so both are always available to display side by side and the
rating that produced the pair is always one click away.

**Because your ratings are judgement, sensitivity is not an optional extra view.** The
hire-vs-subcontract output leads with the efficiency at which the answer flips, not with
a single dollar figure. See §11.5.

---

## 8. The tax rules layer

### 8.1 Nothing is a constant

Every rate, threshold, tier and test parameter is a **sourced value**:

```jsonc
// packages/tax-rules/rulesets/FY2026-27/NSW.json  — shape only, values not yet sourced
{
  "jurisdiction": "NSW",
  "financial_year": "2026-27",
  "threshold": {
    "annual": { "value": null, "unit": "AUD",
                "source_name": "Revenue NSW",
                "source_url": "", "retrieved_date": "", "note": "" }
  },
  "rate": { "value": null, "unit": "fraction", "source_name": "...", "source_url": "",
            "retrieved_date": "" },
  "surcharges": [
    { "code": "", "label": "", "applies_above_au_wide_wages": { "value": null, ... },
      "rate": { "value": null, ... } }
  ],
  "apportionment": { "threshold_basis": "days_employed_in_jurisdiction",
                     "au_wide_wages_basis": "share_of_australia_wide_wages",
                     "source_url": "", "retrieved_date": "" },
  "contractor_exemptions": [
    { "code": "", "label": "", "test_type": "days | percentage | character_of_service",
      "parameter": { "value": null, ... }, "evidence_required": "", "source_url": "" }
  ],
  "employment_agency": { "liable_party": "", "overrides_contractor_exemptions": null,
                         "source_url": "", "retrieved_date": "" },
  "wage_inclusions": { "superannuation": { "treatment": null, "source_url": "" } },
  "rounding": { "basis": "", "source_url": "" }
}
```

The TypeScript type is `SourcedValue<T> = { value: T; source_name: string; source_url: string; retrieved_date: string; note?: string }`. **A bare number will not compile.** That is the mechanism that stops me, or anyone later, filling a threshold in from memory.

When I build, I will populate these from Revenue NSW, the State Revenue Office Victoria,
the Queensland Revenue Office and RevenueWA directly, and record the URL and retrieval
date against each value. Anything I cannot verify from source I will leave `null` with
the field flagged in the UI as unsourced rather than guessed — including where Victoria
and the ACT have changed recently. The application will refuse to produce a payroll tax
figure for a jurisdiction whose ruleset has unsourced values, and will say which.

Superannuation guarantee rate, the OTE maximum contribution base, and workers
compensation rates are in the same national/`workers-comp` ruleset files with the same
sourcing requirement — configuration, not constants. Workers comp defaults per
jurisdiction with a per-entity and per-role override, since your rate depends on your
industry classification and claims history.

### 8.2 Rulesets are pinned to calculation runs

```
tax_ruleset                                         -- loaded from the JSON at deploy
  id, financial_year, jurisdiction_code, version, content_hash, loaded_at, content jsonb

calc_run
  id, scenario_id, run_at, run_by
  ruleset_version_ids[]                             -- pinned
  inputs_hash
  results jsonb, trace jsonb
```

A run from six months ago reproduces exactly, because it names the ruleset it used. When
rates change on 1 July, a new ruleset version lands and old runs are untouched.

### 8.3 Marginal payroll tax

The requirement that "the next hire may attract no payroll tax until the threshold is
crossed" is answered by computing the marginal rate numerically rather than looking one
up:

```
marginal_rate(j, W, ΔW) = [ tax_j(W + ΔW) − tax_j(W) ] ÷ ΔW
```

where `W` is current annual taxable wages in jurisdiction `j` and `ΔW` is the wages the
proposed hire adds. This is the only formulation that gets all four cases right:

- Below the apportioned threshold both before and after → marginal rate is **zero**.
- Straddling the threshold → a blended rate somewhere between zero and the headline
  rate, which is the number that actually decides the hire.
- Above the threshold throughout → the headline rate.
- Crossing a surcharge tier → the step is captured, including where a surcharge applies
  to all wages above a tier rather than only the excess.

The exposure dashboard reports headroom to each of these boundaries in dollars, so you
can see how many more people fit before the rate changes. Grouped calculations apply one
threshold across the group; today, with one entity, that reduces to one threshold, but
the code path is the same.

---

## 9. The demand interface — hours sold

This is the seam to the future demand app, so it is a first-class contract rather than
an import script.

```
demand_source
  id, name, kind                                    manual | csv | api
  api_credential_ref, active

hours_sold_import
  id, demand_source_id, received_at, idempotency_key
  row_count, status, rejected_rows jsonb, raw_payload_ref

hours_sold
  id, import_id, external_id                        -- upsert key from the source system
  period_start, period_end                          -- arbitrary range; bucketed on read
  jurisdiction_code, office_id                      -- office optional
  role_id, role_family_id                           -- either grain accepted
  job_type_id
  hours_sold                                        -- RAW hours of demand
  basis            contracted | forecast | weighted_pipeline
  probability_pct                                   -- NULL unless weighted_pipeline
  project_ref, delivery_start, delivery_end
  confidence, superseded_by
```

Three design points:

1. **This application never forecasts.** It consumes `hours_sold`, and where `basis` is
   `weighted_pipeline` it uses `hours_sold × probability_pct` exactly as supplied. All
   weighting judgement stays in the demand tool. The `basis` and `probability_pct`
   columns exist now so the demand app can start sending weighted pipeline without a
   migration or a renegotiated contract.
2. **One path, three sources.** Manual entry, CSV upload and
   `POST /api/v1/demand/hours-sold` all write through the same validator into the same
   table. Whatever the demand app eventually sends is already exercised by your CSV
   imports.
3. **Idempotent upsert on `(demand_source, external_id)`**, with supersession rather
   than deletion. The demand app can re-send its whole book nightly without duplicating
   demand or destroying the history of what it previously thought.

Hours sold are **raw** hours of work required. Capacity is compared in effective hours,
so the comparison converts one side explicitly and shows the conversion — see §11.2.

---

## 10. Calculation pipeline and traceability

Every output number is a `Traced<T>`:

```ts
type Trace = {
  label: string;              // "Payroll tax — VIC — marginal on proposed hire"
  rule_ref?: string;          // "VIC.surcharges[0]" — resolves to source_url + retrieved_date
  formula: string;            // human-readable, e.g. "(tax(W+ΔW) − tax(W)) / ΔW"
  inputs: Record<string, Traced<unknown>>;
  result: { value: unknown; unit: string };
  flags: Flag[];              // stale_efficiency_rating | unevidenced_exemption
                              // | unsourced_ruleset_value | nexus_undetermined
  children: Trace[];
};
```

Clicking any figure in any dashboard opens its tree and walks down to the raw inputs and
the rule applied — including which efficiency rating was used, from which subject level,
rated by whom, and when it was last reviewed. Flags propagate upward, so a total built
on one stale rating is visibly built on a stale rating.

Pipeline, in order:

```
1. resolve      effective-dated snapshot at the run date, + scenario overlay
2. remunerate   base + resolved cost components → total cost per person
3. classify     each component → taxable wages per jurisdiction (ruleset)
4. nexus        assign each wage period to a jurisdiction
5. deem         contractor / employment agency assessment → deemed wages
6. threshold    apportion by AU-wide share and days employed; apply group
7. tax          apply rates and surcharge tiers; compute marginal rates
8. capacity     contracted → less deductions → × utilisation → × efficiency
9. rates        actual cost rate per effective hour vs sell rate
10. overhead    three recovery methods, computed in parallel
11. compare     capacity vs hours sold; burn-down; shortfall costing
```

Steps 1–7 are the tax path, 8–11 the commercial path. They meet at step 9, where
payroll tax at the **marginal** rate enters the cost rate.

---

## 11. Outputs → how each is served

### 11.1 Exposure dashboard
Per jurisdiction: taxable wages (own + deemed), apportioned threshold with its
apportionment working, tax payable, position against threshold, and headroom in dollars
to the next threshold or surcharge boundary. Every figure traceable to §10.

### 11.2 Capacity dashboard
Raw and effective hours side by side at every level — office, state, role, period.
Hours sold overlaid, surplus/shortfall per bucket, and a cumulative burn-down across the
financial year showing the week you run out, not merely that you do. Where there is a
shortfall, an attached costing: how many heads by role and engagement type close it, and
what each option costs per effective hour after efficiency and marginal payroll tax.

### 11.3 Deemed wages register
Every supplier engagement, cumulative **distinct** days per supplier per FY per
jurisdiction, deemed/exempt status with the exemption code and its source, liable party
for agency arrangements, and a warning band as a supplier approaches a days test limit —
with the dollar consequence of crossing it, not just the fact.

### 11.4 Rate card view
Per role per office: actual cost rate per effective hour vs each sell rate (standard,
after-hours, weekend, public holiday, project override), margin in dollars and percent,
contribution after overhead under each of the three recovery methods, and the utilisation
required to break even. Any role whose sell rate does not cover actual cost is
highlighted, ranked by annualised dollars lost rather than by percentage.

Each rate is tested against the right cost base for its `overhead_treatment` (§L5.7):
direct cost for rates recovered via the admin charge, fully loaded cost for rates that
carry overhead themselves. The view labels which convention each rate is on, so nobody
compares two rates that are not measuring the same thing.

```
sell_rate
  role_id, jurisdiction_code, office_id             -- office optional
  rate_type      standard | after_hours | weekend | public_holiday | project_override
  project_ref                                       -- required when project_override
  rate_cents_per_hour, valid_from, valid_to
```

### 11.5 Hire vs subcontract
Fully loaded employee cost per effective hour against subcontract cost per effective
hour with payroll tax applied where deemed, at the marginal rate. Outputs a breakeven in
billable hours per week, and — because your efficiency figures are judgement — leads
with the sensitivity: **the efficiency percentage at which the cheaper option stops
being cheaper**, with utilisation and efficiency as the two axes of a surface you can
read off. Stated as a range against your rating's confidence level, not a false-precision
point estimate.

### 11.6 Scenario comparison
```
scenario
  id, name, base_scenario_id, financial_year, created_by, notes, locked_at

scenario_change
  scenario_id, change_type    add_person | remove_person | change_role | change_office
                              | change_remuneration | add_engagement | change_efficiency
                              | change_sell_rate | change_utilisation
                              | add_expense | change_expense | remove_expense
  payload jsonb, effective_from, note
```
Scenarios are **overlays**, never mutations of base data. Any scenario diffs against
actuals or against another scenario on total cost, margin, capacity and threshold
position. Because the calc engine is pure and runs in the browser, editing a scenario
updates every figure without a save.

### 11.7 Overhead attribution and recovery — two stages, not one

Shared roles (§5.5) make this a two-stage problem, and conflating the stages is how
office P&Ls become unarguable-with:

```
stage 1  ATTRIBUTION   person cost + operating expenses → offices   via cost_allocation
stage 2  RECOVERY      office overhead pool → rate per hour         via overhead_policy
```

The pool is **non-billable role cost plus allocated operating expenses** (Layer 5). The
rate build-up shows the overhead loading as its own visible line, broken down by category
group, rather than folded invisibly into one number — so when a cost rate moves you can
see whether it was a pay review or the warehouse lease.

```
overhead_policy
  scenario_id, method       per_billable_hour | per_office | by_revenue_share
  params jsonb, note
```

All three recovery methods are computed on every run and shown together, because they
give different answers and the difference is itself the information. One is marked as
your reporting default.

#### The coverage test — the primary output

Your test is simple, and the tool should lead with it rather than bury it under recovery
methods:

> **Does the admin charge, at conservative revenue, cover the non-billable staff cost?**

```
coverage_position                                   -- derived, per office and national
  period, office_id                                 -- NULL = national
  non_billable_cost_cents                           -- FULLY LOADED, see below
  charge_collected_cents                            -- at the selected revenue basis
  coverage_pct, surplus_deficit_cents
  charge_pct_required_for_100                       -- what the fee would need to be
```

One gauge, three numbers: coverage percentage, dollars over or short, and the fee that closes
the gap. The hire decision reads straight off it — *"adding a Perth warehouse person takes
coverage from 108% to 94%; holding coverage at 100% moves the admin fee from 7.5% to 8.1%."*
That is the whole loop you described, on one screen.

Two things that will bite if left implicit:

**The pool includes absorbed function cost (§L5.3.1), not just people with non-billable job
titles.** Warehousing done by a technician at a site with no warehouse person is warehouse cost;
leaving it out flatters the coverage figure.

**"Covering those wages" has to mean fully loaded cost, not salary.** Superannuation, workers
compensation, payroll tax, leave, vehicle, phone and the rest sit on top and routinely add 25
to 40 percent. A fee set against base wages under-recovers by that margin permanently, and the
gap never appears as a line item — it shows up as margin being thinner than expected, for
years. The pool in `coverage_position` is fully loaded cost, and the trace splits it into base
and on-costs so the difference is visible rather than assumed.

**Payroll tax on the pool is marginal, not average (§8.3).** A non-billable hire that pushes a
state across its threshold costs more than the hire before it. The coverage test uses the
marginal rate, so the fee impact of the *next* head is right even when the average looked
comfortable.

#### Coverage per state, not only nationally

One warehouse worker per state makes warehousing a **local** cost — allocated 100% to its own
office, not a shared national role like procurement, finance and head of projects. So the pool
splits, and so does the test:

| Pool | Roles | Allocation |
|---|---|---|
| National shared | Procurement, finance, head of projects | Hours sold (§5.5) |
| State direct | Warehouse worker | 100% to its own office |

That matters more than it looks. A fixed local cost against variable local volume concentrates
the risk in your smallest state: Perth carries the same warehouse wage as Sydney on a fraction
of the hours sold. National coverage can read 105% while WA sits at 80%, and the national
figure on its own will tell you everything is fine. The view reports both, and defaults to
showing the worst state alongside the national number.

#### Behind that — the recovery detail

```
overhead_recovery_position                          -- derived, per pool
  office_id, recovery_pool_id, period
  overhead_cost_allocated_cents                     -- what landed here (L5.5)
  overhead_recovered_cents                          -- what the charge collected
  variance_cents, recovery_pct
```

Three further views come off it:

1. **Recovery position** per office, per period, cumulative for the year. *"The admin charge
   recovers 82% of non-billable cost in QLD."*
2. **Breakeven charge rate** — what the charge would have to be to fully recover the pool.
   Directly actionable: *"you charge 7.5%, you need 9.2%."*
3. **Recovery sensitivity to volume.** Your overhead cost is largely fixed; your recovery is
   a percentage of project volume. So a slow year under-recovers twice over — fewer projects
   carrying an unchanged cost base. The tool reports **the hours-sold level at which recovery
   breaks even**, plotted against the capacity burn-down, so a demand shortfall and an
   overhead shortfall appear on the same axis. They are the same event and are usually
   discovered separately, months apart.

**The office performance view carries a toggle**: direct cost only, versus direct plus
allocated share. Both are true and they answer different questions — direct-only is what
the office manager controls, direct-plus-allocated is whether the office pays for itself.
Showing only one invites the argument that the other was hidden.

Every allocated dollar is traceable in both directions: an office's cost line expands to
*"$X allocated from 3 shared roles under driver `office_headcount`"*, naming the people
and the driver value used. A state manager who disputes their number can see exactly what
produced it, which is the difference between a figure people act on and a figure people
relitigate.

---

## 12. CSV import

Four importers, sharing one pipeline: upload → header mapping (saved per source system,
so a repeat import from the same export is one click) → validation with per-row errors →
preview diff of what will change → commit.

| Importer | Key columns |
|---|---|
| People | external_ref, name, role, office, engagement type, basis, rate, start/end |
| Cost components | person external_ref, component code, enabled, value |
| Supplier engagements | supplier ABN, role, job type, rate, hours, **work dates** |
| Hours sold | period, jurisdiction, role or family, hours, basis, probability, project ref |

Imports are re-runnable and idempotent on `external_ref`. Unknown roles, offices or
suppliers are surfaced as a mapping decision, never auto-created silently. If you tell
me what you export from today (Simpro, Aroflo, D-Tools, Xero, a spreadsheet), I will
match the importers to those file shapes rather than inventing a format you have to
produce.

---

## 13. Open questions

None of these block me starting; each changes a detail:

1. **Roughly what headcount and how many suppliers?** 25 people and 6 suppliers versus
   200 and 60 changes UI density and paging, not the schema.
2. **Are you currently over or under the payroll tax threshold in each state?** If you
   are under in, say, WA, the marginal-rate view becomes the headline of the hire
   decision rather than a footnote.
3. **Do you pay wages anywhere outside the four states**, even occasionally? It changes
   the Australia-wide wages figure and therefore every apportioned threshold.
4. **Casual loading and overtime**: a standard loading percentage, or per-person?
5. **Do sell rates vary by client as well as by role, state and project?** If yes, I add
   a client dimension to `sell_rate` now rather than later.
6. **Workers compensation**: one policy rate per state, or different rates by role
   classification within a state?
7. **What do you export from today** for people, hours and supplier invoices? Drives the
   CSV importer shapes.
8. **Who else will use this**, and should they see individual remuneration? Confirms §2.4.
9. **Can you export a project register for the last 12 months** — value, labour/equipment
   split, type, channel, office, dates? Without it the backtest in §L5.8 cannot run, and
   the backtest is the thing that makes the charge defensible.
10. **What is the project admin charge today, exactly?** A percentage of project labour, of total
   project value, or a fixed amount per project — and what is the current rate? Any floor
   or cap? Does it vary by office or job type?
11. **Do your sell rates currently carry overhead as well?** This is the double-count
   question in §L5.7. If the rate card was built with a loading in it *and* you charge
   admin on top, your real margin differs from your reported margin, in one direction or
   the other.
12. **What covers property, fleet and technology?** The admin charge covers non-billable
   staff. If those are meant to come out of gross margin, I will assign them to the
   rate-loaded pool; if nothing covers them, that is worth seeing stated.
13. **Which other roles are shared** besides procurement? I would guess finance, and
   possibly parts of sales and warehousing.

---

## 14. Proposed build order

1. `@wf/tax-rules` — ruleset shape, sourced-value types, and populating FY2026–27 from
   the four revenue offices with sources recorded. Nothing depends on guesses.
2. `@wf/calc` — cost, capacity, efficiency, marginal tax, with the trace built in from
   the first function rather than bolted on. Golden-file tests against worked examples
   from revenue office guidance.
3. Schema and migrations, seed data for role families, cost components, time deductions,
   job types.
4. CSV importers, so you can load a real headcount and see real numbers early.
5. API with the demand endpoint documented in OpenAPI.
6. The six dashboards, exposure and capacity first.

I would rather show you working numbers for your actual headcount at step 4 than a
complete UI over invented data.

---

## 15. Getting sign-off — who to involve, and when

Three different conversations, and running them as one is how a tool like this stalls.

**Now, with your accountant — not the C-suite.** Specialist questions whose answers change
the outputs rather than the design:

- Nexus treatment for shared roles: the VIC-based procurement manager (§5.5).
- Classification of your labour hire and subcontract arrangements, and which contractor
  exemptions are genuinely available and evidenced (§6.1).
- Whether the admin charge and the sell rate are currently double-recovering overhead
  (§L5.7). This one is a real dollars question, not a modelling nicety.

**Next, with delivery and finance leads — the methodology, before any numbers exist.** The
allocation driver is genuinely arbitrary (§5.5), and this tool will eventually produce a
number saying which state is performing and which roles lose money at current rates. Those
are things people own. Agree the method while it is abstract; once the numbers land, any
disagreement about method reads as a disagreement about the result, and the conversation
becomes about the denominator instead of the finding.

**Then the C-suite, with a backtest and a live decision — not a schema.** The schema is not a
C-suite artefact; nobody will read table definitions, and asking them to produces vague assent
rather than buy-in. Go when you can put three things on the table:

1. Current recovery position — are we covering shared cost, and by how much are we not.
2. The proposed tier structure, backtested against last year's actual projects (§L5.8).
3. The hire-versus-subcontract answer for one real decision you are facing anyway.

That is a twenty-minute conversation with numbers in it, and it ends in a decision. The
version where you present a data model ends in "looks good, keep going", which is not the
same thing.

---

*Indicative only. Requires review by a registered tax agent before you rely on it.*
