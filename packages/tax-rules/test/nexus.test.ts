import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadRuleset } from '../src/load.ts';
import { resolveNexus, type NexusFacts } from '../src/rules/nexus.ts';
import { dollarsToCents } from '../src/money.ts';

const nsw = loadRuleset('FY2026-27', 'NSW');

const base: NexusFacts = {
  month: '2026-09',
  servicesPerformedIn: ['NSW'],
  servicesPerformedOutsideAustralia: false,
  employeePpr: 'NSW',
  employerAbnAddress: 'NSW',
  employerPpb: 'NSW',
  wagesPaidBy: { NSW: dollarsToCents('8000') },
  timeWorkedBy: { NSW: 160 },
};

describe('PTA039 step 1 — the wholly-performed test', () => {
  test('services wholly in one jurisdiction land there and stop', () => {
    const out = resolveNexus({ ...base }, nsw);
    assert.equal(out.result.jurisdiction, 'NSW');
    assert.equal(out.result.ruleApplied, 'step1_wholly_performed_in_one_jurisdiction');
  });

  test('a full calendar month in another jurisdiction moves the wages there', () => {
    // The §4.1 case: a NSW-resident technician who spends the whole of September in the NT.
    const out = resolveNexus(
      { ...base, servicesPerformedIn: ['NT'], timeWorkedBy: { NT: 160 } },
      nsw,
    );
    assert.equal(out.result.jurisdiction, 'NT', 'step 1 is satisfied for the NT despite a NSW residence');
    assert.equal(out.result.ruleApplied, 'step1_wholly_performed_in_one_jurisdiction');
  });

  test('the place of work need not be where the employee usually works', () => {
    const out = resolveNexus({ ...base, servicesPerformedIn: ['VIC'], timeWorkedBy: { VIC: 160 } }, nsw);
    assert.equal(out.result.jurisdiction, 'VIC');
  });
});

describe('PTA039 tier 1 — principal place of residence', () => {
  test('residence outranks where the work happened, and tier 4 is never reached', () => {
    // The §4.1 case: a NSW resident spends one week of the month in Darwin.
    const out = resolveNexus(
      {
        ...base,
        servicesPerformedIn: ['NSW', 'NT'],
        timeWorkedBy: { NSW: 120, NT: 40 },
      },
      nsw,
    );
    assert.equal(out.result.jurisdiction, 'NSW');
    assert.equal(out.result.ruleApplied, 'tier1_employee_ppr');
    const steps = out.trace.map((t) => t.step);
    assert.ok(!steps.includes('tier4_services_mainly_performed'), 'tier 4 must not be reached');
  });

  test('residence still wins where most of the time was worked elsewhere', () => {
    const out = resolveNexus(
      { ...base, servicesPerformedIn: ['NSW', 'NT'], timeWorkedBy: { NSW: 20, NT: 140 } },
      nsw,
    );
    assert.equal(out.result.jurisdiction, 'NSW', 'tier 1 resolves before time worked is considered');
  });

  test('a corporate deemed employee uses its ABN address', () => {
    const out = resolveNexus(
      {
        ...base,
        servicesPerformedIn: ['NSW', 'QLD'],
        employeePpr: null,
        corporateDeemedEmployee: { abnAddress: 'QLD', ppb: 'NSW' },
      },
      nsw,
    );
    assert.equal(out.result.jurisdiction, 'QLD');
    assert.equal(out.result.ruleApplied, 'tier1_corporate_deemed_employee_abn_address');
  });

  test('a corporate deemed employee with no ABN address falls back to its PPB', () => {
    const out = resolveNexus(
      {
        ...base,
        servicesPerformedIn: ['NSW', 'QLD'],
        employeePpr: null,
        corporateDeemedEmployee: { abnAddress: null, ppb: 'WA' },
      },
      nsw,
    );
    assert.equal(out.result.jurisdiction, 'WA');
    assert.equal(out.result.ruleApplied, 'tier1_corporate_deemed_employee_ppb');
  });

  test('two or more ABN addresses in the jurisdiction also fall back to PPB', () => {
    const out = resolveNexus(
      {
        ...base,
        servicesPerformedIn: ['NSW', 'QLD'],
        employeePpr: null,
        corporateDeemedEmployee: {
          abnAddress: 'QLD',
          hasMultipleAbnAddressesInJurisdiction: true,
          ppb: 'VIC',
        },
      },
      nsw,
    );
    assert.equal(out.result.jurisdiction, 'VIC');
  });
});

describe('PTA039 tier 2 — employer ABN address, then principal place of business', () => {
  test('resolves on the employer ABN address where the employee has no Australian PPR', () => {
    const out = resolveNexus(
      { ...base, servicesPerformedIn: ['NSW', 'VIC'], employeePpr: null, employerAbnAddress: 'VIC' },
      nsw,
    );
    assert.equal(out.result.jurisdiction, 'VIC');
    assert.equal(out.result.ruleApplied, 'tier2_employer_abn_address');
  });

  test('falls to PPB where the employer has ABN addresses in different jurisdictions', () => {
    const out = resolveNexus(
      {
        ...base,
        servicesPerformedIn: ['NSW', 'VIC'],
        employeePpr: null,
        employerAbnAddress: 'VIC',
        employerHasMultipleAbnAddressesInDifferentJurisdictions: true,
        employerPpb: 'WA',
      },
      nsw,
    );
    assert.equal(out.result.jurisdiction, 'WA');
    assert.equal(out.result.ruleApplied, 'tier2_employer_ppb');
  });
});

describe('PTA039 tier 3 — where the wages are paid', () => {
  test("the ruling's own Mary example: NSW $200, VIC $300, SA $1,000 aggregates to SA", () => {
    const out = resolveNexus(
      {
        ...base,
        servicesPerformedIn: ['NSW', 'VIC', 'SA'],
        employeePpr: null,
        employerAbnAddress: null,
        employerPpb: null,
        wagesPaidBy: {
          NSW: dollarsToCents('200'),
          VIC: dollarsToCents('300'),
          SA: dollarsToCents('1000'),
        },
      },
      nsw,
    );
    assert.equal(out.result.jurisdiction, 'SA');
    assert.equal(out.result.ruleApplied, 'tier3_wages_paid');
    const step = out.trace.find((t) => t.step === 'tier3_wages_paid');
    assert.ok(step?.detail.includes('150000'), 'the trace must show the $1,500 aggregate in cents');
  });

  test('an equal largest proportion is flagged, not guessed', () => {
    const out = resolveNexus(
      {
        ...base,
        servicesPerformedIn: ['NSW', 'VIC'],
        employeePpr: null,
        employerAbnAddress: null,
        employerPpb: null,
        wagesPaidBy: { NSW: dollarsToCents('500'), VIC: dollarsToCents('500') },
      },
      nsw,
    );
    assert.equal(out.result.jurisdiction, null);
    assert.ok(out.unresolved?.includes('tied') || out.unresolved?.includes('Tier 3 is tied'));
  });
});

describe('PTA039 tier 4 — services mainly performed', () => {
  test('more than 50% of actual time worked resolves the month', () => {
    const out = resolveNexus(
      {
        ...base,
        servicesPerformedIn: ['NSW', 'VIC'],
        employeePpr: null,
        employerAbnAddress: null,
        employerPpb: null,
        wagesPaidBy: {},
        timeWorkedBy: { NSW: 100, VIC: 60 },
      },
      nsw,
    );
    assert.equal(out.result.jurisdiction, 'NSW');
    assert.equal(out.result.ruleApplied, 'tier4_services_mainly_performed');
  });

  test('exactly 50% is not "mainly", so nothing is taxable in Australia', () => {
    const out = resolveNexus(
      {
        ...base,
        servicesPerformedIn: ['NSW', 'VIC'],
        employeePpr: null,
        employerAbnAddress: null,
        employerPpb: null,
        wagesPaidBy: {},
        timeWorkedBy: { NSW: 80, VIC: 80 },
      },
      nsw,
    );
    assert.equal(out.result.jurisdiction, null);
    assert.equal(out.result.ruleApplied, 'not_taxable_in_any_australian_jurisdiction');
  });
});

describe('PTA039 — services outside every Australian jurisdiction', () => {
  test('more than six continuous months in another country is exempt', () => {
    const out = resolveNexus(
      {
        ...base,
        servicesPerformedIn: [],
        servicesPerformedOutsideAustralia: true,
        continuousMonthsWhollyInAnotherCountry: 7,
      },
      nsw,
    );
    assert.equal(out.result.jurisdiction, null);
    assert.equal(out.result.ruleApplied, 'exempt_overseas_more_than_six_months');
  });

  test('six months or fewer is taxable where the wages are paid', () => {
    const out = resolveNexus(
      {
        ...base,
        servicesPerformedIn: [],
        servicesPerformedOutsideAustralia: true,
        continuousMonthsWhollyInAnotherCountry: 3,
        wagesPaidBy: { NSW: dollarsToCents('8000') },
      },
      nsw,
    );
    assert.equal(out.result.jurisdiction, 'NSW');
    assert.equal(out.result.ruleApplied, 'wholly_outside_australia_wages_paid');
  });

  test('an unknown assignment length is flagged rather than assumed', () => {
    const out = resolveNexus(
      { ...base, servicesPerformedIn: [], servicesPerformedOutsideAustralia: true },
      nsw,
    );
    assert.ok(out.unresolved, 'must not guess between the offshore and another-country branches');
  });
});

describe('every determination carries its working', () => {
  test('trace and citations are always populated', () => {
    const out = resolveNexus({ ...base }, nsw);
    assert.ok(out.trace.length > 0, 'a determination must show its working');
    assert.ok(out.citations.length > 0, 'a determination must cite the ruling');
    for (const c of out.citations) {
      assert.match(c.source_url, /^https:\/\//, 'every citation carries a source URL');
      assert.match(c.retrieved_date, /^\d{4}-\d{2}-\d{2}$/, 'every citation carries a retrieval date');
    }
  });
});
