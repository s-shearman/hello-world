import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadRuleset } from '../src/load.ts';
import { apportionedDeduction, deductibleAmount, monthlyThreshold, rateFor, taxPayable } from '../src/rules/threshold.ts';
import { applyPpm, centsToDollars, divRoundHalfUp, dollarsToCents } from '../src/index.ts';
import { mustBeSourced } from './assert-sourced.ts';

const FY = 'FY2026-27';

/**
 * Golden files, per CLAUDE.md: the revenue offices' own worked examples become the
 * regression tests. If one of these drifts, either we broke the engine or the office
 * changed the rule — and both are things we want to hear about loudly.
 */

describe('Revenue NSW worked examples — interstate and part-year apportionment', () => {
  const nsw = loadRuleset(FY, 'NSW');

  test('example 1: interstate share then 184 days gives $201,643.84', () => {
    const out = apportionedDeduction(nsw, dollarsToCents('3000000'), {
      daysEmployedInJurisdiction: 184,
      daysInFinancialYear: 365,
      jurisdictionWages: dollarsToCents('1000000'),
      auWideWages: dollarsToCents('3000000'),
    });
    assert.equal(centsToDollars(out.result), '201643.84');
    assert.equal(out.unresolved, undefined);
  });

  test('example 2: employed elsewhere all year, so no days step, gives $400,000', () => {
    const out = apportionedDeduction(nsw, dollarsToCents('3000000'), {
      daysEmployedInJurisdiction: 365,
      daysInFinancialYear: 365,
      jurisdictionWages: dollarsToCents('1000000'),
      auWideWages: dollarsToCents('3000000'),
    });
    assert.equal(centsToDollars(out.result), '400000.00');
  });

  test('published monthly thresholds reproduce from the derivation', () => {
    for (const ex of nsw.monthly_threshold.published_examples) {
      mustBeSourced(ex.amount, `the ${ex.days_in_month}-day published example`);
      const out = monthlyThreshold(nsw, ex.days_in_month, ex.days_in_year);
      assert.equal(
        out.result,
        ex.amount.value,
        `${ex.days_in_month} days: derived $${centsToDollars(out.result)} but Revenue NSW publishes $${centsToDollars(ex.amount.value)}`,
      );
    }
  });
});

describe('RevenueWA worked examples — diminishing threshold', () => {
  const wa = loadRuleset(FY, 'WA');

  test('$1,200,000 of wages gives a deductable amount of $969,231', () => {
    const out = deductibleAmount(wa, dollarsToCents('1200000'));
    assert.equal(centsToDollars(out.result), '969231.00');
  });

  test('monthly wages of $92,000 produce payroll tax of $6,600', () => {
    const auWide = dollarsToCents('1104000');
    const out = taxPayable(wa, {
      daysEmployedInJurisdiction: 365,
      daysInFinancialYear: 365,
      jurisdictionWages: auWide,
      auWideWages: auWide,
    });
    // WA's own example is a WA-only employer, so the unsourced interstate-share basis is
    // what stops this being assertable — the arithmetic still has to match.
    assert.equal(centsToDollars(out.result), '6600.00');
  });

  test('no deduction at or above the $7.5m upper threshold', () => {
    const out = deductibleAmount(wa, dollarsToCents('7500000'));
    assert.equal(out.result, 0n);
  });

  test('full deduction at or below the $1m annual threshold', () => {
    const out = deductibleAmount(wa, dollarsToCents('1000000'));
    assert.equal(centsToDollars(out.result), '1000000.00');
  });
});

describe('State Revenue Office Victoria worked example — monthly deduction and tax', () => {
  const vic = loadRuleset(FY, 'VIC');

  test('monthly deduction is $27,777.67 on a Victorian share of one third', () => {
    const monthly = monthlyThreshold(vic, 31, 365);
    assert.equal(centsToDollars(monthly.result), '83333.00');
    // $83,333 x $2,000,000 / $6,000,000, through the engine's own rounding
    const share = divRoundHalfUp(
      monthly.result * dollarsToCents('2000000'),
      dollarsToCents('6000000'),
    );
    assert.equal(centsToDollars(share), '27777.67');
  });

  test('tax on $40,000 of monthly wages is $592.78', () => {
    const rate = rateFor(vic, dollarsToCents('2000000'));
    assert.equal(rate.result, 48500n, 'metropolitan Victorian rate is 4.85%');
    const taxable = dollarsToCents('40000') - dollarsToCents('27777.67');
    assert.equal(centsToDollars(applyPpm(taxable, rate.result)), '592.78');
  });

  test('deduction phases out to nil at $5,000,000 of Australian wages', () => {
    assert.equal(deductibleAmount(vic, dollarsToCents('5000000')).result, 0n);
    assert.equal(centsToDollars(deductibleAmount(vic, dollarsToCents('3000000')).result), '1000000.00');
    assert.equal(centsToDollars(deductibleAmount(vic, dollarsToCents('4000000')).result), '500000.00');
  });
});

describe('State Revenue Office Tasmania — two rate bands', () => {
  const tas = loadRuleset(FY, 'TAS');

  test('monthly threshold derives from days in month over days in year', () => {
    const out = monthlyThreshold(tas, 31, 365);
    // $1.25m x 31/365 = $106,164.38, rounded to the nearest whole dollar per the source
    assert.equal(centsToDollars(out.result), '106164.00');
  });

  test('4.0% applies between $1.25m and $2.0m, 6.1% above', () => {
    const facts = (auWide: string, jurisdiction: string) => ({
      daysEmployedInJurisdiction: 365,
      daysInFinancialYear: 365,
      jurisdictionWages: dollarsToCents(jurisdiction),
      auWideWages: dollarsToCents(auWide),
    });
    const low = taxPayable(tas, facts('1500000', '1500000'));
    // ($1,500,000 - $1,250,000) x 4.0% = $10,000
    assert.equal(centsToDollars(low.result), '10000.00');
    const high = taxPayable(tas, facts('3000000', '3000000'));
    // ($3,000,000 - $1,250,000) x 6.1% = $106,750
    assert.equal(centsToDollars(high.result), '106750.00');
  });
});
