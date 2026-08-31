import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JURISDICTIONS, type Jurisdiction, type Ruleset } from './types.ts';
import { isUnsourced, type Maybe } from './sourced-value.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Values in the JSON carry an explicit `unit` so the loader knows what to widen into a
 * bigint. Nothing is inferred from the shape of the literal — a money value and a label
 * both arrive as strings, and guessing between them is exactly the class of quiet error
 * this package exists to prevent.
 */
type Unit = 'cents' | 'ppm' | 'rational';

function parseUnit(unit: Unit, raw: unknown, path: string): unknown {
  switch (unit) {
    case 'cents':
    case 'ppm': {
      if (typeof raw === 'string') {
        if (!/^-?\d+$/.test(raw)) throw new Error(`${path}: ${unit} must be an integer string, got ${JSON.stringify(raw)}`);
        return BigInt(raw);
      }
      if (typeof raw === 'number') {
        if (!Number.isInteger(raw)) throw new Error(`${path}: ${unit} must be an integer, got ${raw}`);
        return BigInt(raw);
      }
      throw new Error(`${path}: ${unit} must be an integer or integer string`);
    }
    case 'rational': {
      const r = raw as { numerator?: unknown; denominator?: unknown };
      if (typeof r?.numerator === 'undefined' || typeof r?.denominator === 'undefined') {
        throw new Error(`${path}: rational needs numerator and denominator`);
      }
      return { numerator: BigInt(String(r.numerator)), denominator: BigInt(String(r.denominator)) };
    }
  }
}

function hydrate(node: unknown, path = '$'): unknown {
  if (Array.isArray(node)) return node.map((n, i) => hydrate(n, `${path}[${i}]`));
  if (node === null || typeof node !== 'object') return node;

  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = hydrate(v, `${path}.${k}`);

  if ('value' in obj && 'unit' in obj && typeof obj['unit'] === 'string') {
    const unit = obj['unit'] as Unit;
    if (unit === 'cents' || unit === 'ppm' || unit === 'rational') {
      out['value'] = obj['value'] === null ? null : parseUnit(unit, obj['value'], path);
    }
  }
  return out;
}

/* ------------------------------------------------------------- the sourcing gate */

/** One unsourced field, named by its path through the ruleset. */
export type SourcingGap = {
  readonly jurisdiction: Jurisdiction;
  readonly path: string;
  readonly reason: string;
};

/** Walk a loaded ruleset and collect every field whose value is still null. */
export function findSourcingGaps(ruleset: Ruleset): SourcingGap[] {
  const gaps: SourcingGap[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, `${path}[${i}]`));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if ('value' in obj) {
      const m = obj as unknown as Maybe<unknown>;
      if (isUnsourced(m)) {
        gaps.push({
          jurisdiction: ruleset.jurisdiction,
          path,
          reason: m.unsourced_reason ?? 'no reason recorded',
        });
      }
      // A sourced value's own `value` may still be a nested object (a rational); it
      // holds no further Maybe fields, so there is nothing below it to walk.
      return;
    }
    for (const [k, v] of Object.entries(obj)) walk(v, `${path}.${k}`);
  };
  walk(ruleset, '');
  return gaps;
}

/**
 * Thrown instead of returning a figure. Per CLAUDE.md the application refuses to produce
 * a payroll tax figure for a jurisdiction whose ruleset has unsourced values, and names
 * which — so the message carries the field paths, not just a count.
 */
export class UnsourcedRulesetError extends Error {
  readonly gaps: ReadonlyArray<SourcingGap>;
  constructor(gaps: ReadonlyArray<SourcingGap>) {
    const by = new Map<string, string[]>();
    for (const g of gaps) {
      const list = by.get(g.jurisdiction) ?? [];
      list.push(`${g.path} (${g.reason})`);
      by.set(g.jurisdiction, list);
    }
    const detail = [...by.entries()]
      .map(([j, fields]) => `${j}: ${fields.join('; ')}`)
      .join(' | ');
    super(
      `Refusing to produce a payroll tax figure — unsourced values in ${by.size} ruleset(s). ${detail}`,
    );
    this.name = 'UnsourcedRulesetError';
    this.gaps = gaps;
  }
}

/** A ruleset that has passed the gate. Rule functions that compute money demand this. */
export type SourcedRuleset = Ruleset & { readonly __fullySourced: true };

/**
 * The strict gate: every value in the ruleset must be sourced.
 */
export function assertFullySourced(ruleset: Ruleset): SourcedRuleset {
  const gaps = findSourcingGaps(ruleset);
  if (gaps.length > 0) throw new UnsourcedRulesetError(gaps);
  return ruleset as SourcedRuleset;
}

/**
 * Fields a base payroll tax figure actually depends on.
 *
 * The gate is scoped by capability rather than applied whole. A missing contractor
 * exemption catalogue must stop us assessing a contractor payment; it should not stop us
 * reporting exposure on ordinary wages, or the tool would refuse everything forever and
 * get switched off. Each capability names its own gaps.
 */
const REQUIRED_FOR_BASE_TAX = [
  '.rate',
  '.deduction',
  '.apportionment',
  '.surcharges',
  '.monthly_threshold',
  // Threshold rounding changes the figure, so it is required. Rounding of tax payable is
  // not: the engine carries exact integer cents end to end and only rounds at the point
  // of presentation or lodgement, so a missing presentation rule cannot corrupt a result.
  '.rounding.monthly_threshold',
];
const REQUIRED_FOR_CONTRACTOR = ['.contractor_exemptions', '.employment_agency'];
const REQUIRED_FOR_NEXUS = ['.nexus'];
/** Superannuation treatment decides what lands in the taxable wage base upstream. */
const REQUIRED_FOR_WAGE_BASE = ['.wage_inclusions'];

function gatedBy(ruleset: Ruleset, prefixes: string[]): SourcingGap[] {
  return findSourcingGaps(ruleset).filter((g) => prefixes.some((p) => g.path.startsWith(p)));
}

/** A ruleset good enough to compute payroll tax on ordinary wages. */
export type BaseTaxRuleset = Ruleset & { readonly __baseTaxSourced: true };

export function assertCanComputeBaseTax(ruleset: Ruleset): BaseTaxRuleset {
  const gaps = gatedBy(ruleset, REQUIRED_FOR_BASE_TAX);
  if (gaps.length > 0) throw new UnsourcedRulesetError(gaps);
  return ruleset as BaseTaxRuleset;
}

/** A ruleset good enough to assess a contractor or labour hire payment. */
export type ContractorRuleset = Ruleset & { readonly __contractorSourced: true };

export function assertCanAssessContractor(ruleset: Ruleset): ContractorRuleset {
  const gaps = gatedBy(ruleset, REQUIRED_FOR_CONTRACTOR);
  if (gaps.length > 0) throw new UnsourcedRulesetError(gaps);
  return ruleset as ContractorRuleset;
}

/** A ruleset whose nexus citation has been verified against the primary ruling. */
export function assertNexusVerified(ruleset: Ruleset): Ruleset {
  const gaps = gatedBy(ruleset, REQUIRED_FOR_NEXUS);
  if (gaps.length > 0) throw new UnsourcedRulesetError(gaps);
  return ruleset;
}

/** A ruleset good enough to decide what belongs in the taxable wage base. */
export function assertCanBuildWageBase(ruleset: Ruleset): Ruleset {
  const gaps = gatedBy(ruleset, REQUIRED_FOR_WAGE_BASE);
  if (gaps.length > 0) throw new UnsourcedRulesetError(gaps);
  return ruleset;
}

/* ------------------------------------------------------------------ file loading */

export function loadRuleset(financialYear: string, jurisdiction: Jurisdiction): Ruleset {
  const file = join(HERE, '..', 'rulesets', financialYear, `${jurisdiction}.json`);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const hydrated = hydrate(raw) as Ruleset;
  if (hydrated.jurisdiction !== jurisdiction) {
    throw new Error(`${file}: declares jurisdiction ${hydrated.jurisdiction}, expected ${jurisdiction}`);
  }
  return hydrated;
}

export function loadAllRulesets(financialYear: string): Record<Jurisdiction, Ruleset> {
  const out = {} as Record<Jurisdiction, Ruleset>;
  for (const j of JURISDICTIONS) out[j] = loadRuleset(financialYear, j);
  return out;
}

/** Which jurisdictions can produce a figure, and which cannot and why. */
export function sourcingReport(financialYear: string): {
  baseTaxReady: Jurisdiction[];
  contractorReady: Jurisdiction[];
  gaps: Array<{ jurisdiction: Jurisdiction; gaps: SourcingGap[] }>;
} {
  const baseTaxReady: Jurisdiction[] = [];
  const contractorReady: Jurisdiction[] = [];
  const all: Array<{ jurisdiction: Jurisdiction; gaps: SourcingGap[] }> = [];
  for (const j of JURISDICTIONS) {
    const rs = loadRuleset(financialYear, j);
    if (gatedBy(rs, REQUIRED_FOR_BASE_TAX).length === 0) baseTaxReady.push(j);
    if (gatedBy(rs, REQUIRED_FOR_CONTRACTOR).length === 0) contractorReady.push(j);
    const g = findSourcingGaps(rs);
    if (g.length > 0) all.push({ jurisdiction: j, gaps: g });
  }
  return { baseTaxReady, contractorReady, gaps: all };
}
