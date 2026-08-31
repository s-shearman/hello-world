import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  JURISDICTIONS,
  UnsourcedRulesetError,
  assertCanComputeBaseTax,
  findSourcingGaps,
  loadAllRulesets,
  loadRuleset,
  sourcingReport,
  taxPayable,
  dollarsToCents,
  assessContractorPayment,
  assessArrangement,
} from '../src/index.ts';
import { mustBeSourced, mustBeUnsourced, mustExist } from './assert-sourced.ts';

const FY = 'FY2026-27';

describe('every jurisdiction has a ruleset that loads', () => {
  test('all eight load and declare the right jurisdiction and year', () => {
    const all = loadAllRulesets(FY);
    assert.equal(Object.keys(all).length, 8);
    for (const j of JURISDICTIONS) {
      assert.equal(all[j].jurisdiction, j);
      assert.equal(all[j].financial_year, 'FY2026-27');
      assert.ok(all[j].ruleset_version.length > 0, 'a ruleset must be versioned for pinning per §8.2');
    }
  });
});

describe('sourced values carry a URL and a retrieval date', () => {
  test('no sourced value anywhere is missing its provenance', () => {
    const all = loadAllRulesets(FY);
    const walk = (node: unknown, path: string, j: string): void => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`, j));
      if (node === null || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      if ('value' in obj) {
        if (obj['value'] !== null) {
          assert.ok(
            typeof obj['source_url'] === 'string' && obj['source_url'].startsWith('http'),
            `${j}${path}: sourced value must carry a source_url`,
          );
          assert.match(
            String(obj['retrieved_date']),
            /^\d{4}-\d{2}-\d{2}$/,
            `${j}${path}: sourced value must carry a retrieved_date`,
          );
          assert.ok(
            typeof obj['source_name'] === 'string' && obj['source_name'].length > 0,
            `${j}${path}: sourced value must name its source`,
          );
        } else {
          assert.ok(
            typeof obj['unsourced_reason'] === 'string' && obj['unsourced_reason'].length > 0,
            `${j}${path}: an unsourced value must say why`,
          );
        }
        return;
      }
      for (const [k, v] of Object.entries(obj)) walk(v, `${path}.${k}`, j);
    };
    for (const j of JURISDICTIONS) walk(all[j], '', j);
  });
});

describe('the gate refuses a figure and names which values are unsourced', () => {
  test('QLD, SA, ACT and NT are refused, each naming its own fields', () => {
    for (const j of ['QLD', 'SA', 'ACT', 'NT'] as const) {
      const rs = loadRuleset(FY, j);
      assert.throws(
        () => assertCanComputeBaseTax(rs),
        (err: unknown) => {
          if (!(err instanceof UnsourcedRulesetError)) {
            throw new Error(`expected an UnsourcedRulesetError, got ${String(err)}`);
          }
          assert.match(err.message, /Refusing to produce a payroll tax figure/);
          assert.match(err.message, new RegExp(j));
          assert.match(err.message, /\.rate/, 'the message must name the field, not just the jurisdiction');
          assert.ok(err.gaps.length > 0);
          return true;
        },
      );
    }
  });

  test('the refusal reason explains why, so the gap is actionable', () => {
    const gaps = findSourcingGaps(loadRuleset(FY, 'QLD'));
    const rate = mustExist(
      gaps.find((g) => g.path === '.rate.rate_ppm'),
      'the .rate.rate_ppm gap',
    );
    assert.match(rate.reason, /egress policy|CONNECT/, 'the reason names the actual obstacle');
    assert.match(rate.reason, /not filled from memory/i);
  });

  test('taxPayable itself refuses for an unsourced jurisdiction', () => {
    assert.throws(
      () =>
        taxPayable(loadRuleset(FY, 'NT'), {
          daysEmployedInJurisdiction: 365,
          daysInFinancialYear: 365,
          jurisdictionWages: dollarsToCents('2000000'),
          auWideWages: dollarsToCents('2000000'),
        }),
      UnsourcedRulesetError,
    );
  });

  test('NSW and Tasmania can compute base payroll tax', () => {
    for (const j of ['NSW', 'TAS'] as const) {
      const gated = assertCanComputeBaseTax(loadRuleset(FY, j));
      assert.equal(gated.jurisdiction, j);
    }
  });

  test('the sourcing report tells you exactly where you stand', () => {
    const r = sourcingReport(FY);
    assert.deepEqual(r.baseTaxReady.sort(), ['NSW', 'TAS']);
    assert.deepEqual(r.contractorReady, [], 'no exemption catalogue has been sourced yet');
    const blocked = r.gaps.map((g) => g.jurisdiction).sort();
    assert.deepEqual(blocked, ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA']);
  });
});

describe('an empty array asserts "none"; null means "we have not looked"', () => {
  test('NSW asserts no surcharge, with a source', () => {
    const nsw = loadRuleset(FY, 'NSW');
    mustBeSourced(nsw.surcharges, 'NSW surcharges');
    assert.deepEqual(nsw.surcharges.value, []);
    assert.match(nsw.surcharges.source_url, /^https:\/\//);
  });

  test('QLD does not assert that, and says so explicitly', () => {
    const qld = loadRuleset(FY, 'QLD');
    mustBeUnsourced(qld.surcharges, 'QLD surcharges');
    assert.match(qld.surcharges.unsourced_reason, /NOT an assertion/);
  });

  test('Victoria carries two surcharge tiers and flags the combined-rate limitation', () => {
    const vic = loadRuleset(FY, 'VIC');
    mustBeSourced(vic.surcharges, 'VIC surcharges');
    assert.equal(vic.surcharges.value.length, 2);
    assert.match(String(vic.surcharges.note), /COMBINED/);
  });
});

describe('contractor payments are deemed by default', () => {
  const nsw = loadRuleset(FY, 'NSW');

  test('a payment with no claim stays fully deemed', () => {
    const out = assessContractorPayment(nsw, dollarsToCents('50000'), null);
    assert.equal(out.result.deemedWages, dollarsToCents('50000'));
    assert.equal(out.result.exemptionApplied, null);
  });

  test('an unsourced catalogue does not let a claim through', () => {
    const out = assessContractorPayment(nsw, dollarsToCents('50000'), {
      exemptionCode: 'anything',
      claimed: true,
      evidenced: true,
    });
    assert.equal(out.result.deemedWages, dollarsToCents('50000'), 'nothing drops out on an unverified code');
    assert.equal(out.result.atRisk, dollarsToCents('50000'));
    assert.ok(out.unresolved);
  });
});

describe('labour hire is assessed ahead of the contractor provisions', () => {
  const nsw = loadRuleset(FY, 'NSW');

  test('a labour hire arrangement offers no contractor exemption path', () => {
    const out = assessArrangement(nsw, 'labour_hire', dollarsToCents('80000'));
    assert.equal(out.result.contractorExemptionsUnavailable, true);
    assert.equal(out.result.deemedWages, dollarsToCents('80000'));
    assert.ok(out.unresolved, 'the liable party cannot be named while the provisions are unsourced');
  });

  test('a sole trader contractor takes the general contractor path', () => {
    const out = assessArrangement(nsw, 'sole_trader_contractor', dollarsToCents('80000'));
    assert.equal(out.result.contractorExemptionsUnavailable, false);
  });
});
