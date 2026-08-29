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
  payload jsonb, effective_from, note
```
Scenarios are **overlays**, never mutations of base data. Any scenario diffs against
actuals or against another scenario on total cost, margin, capacity and threshold
position. Because the calc engine is pure and runs in the browser, editing a scenario
updates every figure without a save.

### 11.7 Overhead recovery
```
overhead_policy
  scenario_id, method       per_billable_hour | per_office | by_revenue_share
  params jsonb, note
```
All three methods are computed on every run and shown together, because they give
different answers and the difference is itself the information. One is marked as your
reporting default.

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

*Indicative only. Requires review by a registered tax agent before you rely on it.*
