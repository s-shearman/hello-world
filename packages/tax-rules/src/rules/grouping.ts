import type { Cents, Jurisdiction, Ruleset } from '../types.ts';
import type { Traced, TraceStep } from '../trace.ts';

/**
 * Grouped calculations apply one threshold across the group (§8.3). Today, with one legal
 * entity, that reduces to one threshold — but the code path is the same one a group would
 * take, so the reduction is not a special case waiting to be rewritten.
 */

export type GroupMember = {
  readonly entityId: string;
  readonly jurisdictionWages: Readonly<Partial<Record<Jurisdiction, Cents>>>;
};

export type GroupPosition = {
  /** Australia-wide wages of the whole group, which is what every threshold test reads. */
  readonly auWideWages: Cents;
  readonly wagesByJurisdiction: Readonly<Partial<Record<Jurisdiction, Cents>>>;
  readonly memberCount: number;
};

export function groupPosition(members: ReadonlyArray<GroupMember>, ruleset: Ruleset): Traced<GroupPosition> {
  const trace: TraceStep[] = [];
  const byJurisdiction: Partial<Record<Jurisdiction, Cents>> = {};
  let auWide = 0n;

  for (const m of members) {
    for (const [j, cents] of Object.entries(m.jurisdictionWages) as Array<[Jurisdiction, Cents]>) {
      byJurisdiction[j] = (byJurisdiction[j] ?? 0n) + cents;
      auWide += cents;
    }
  }

  trace.push({
    step: 'group_aggregation',
    detail:
      members.length === 1
        ? `A single entity, so the group threshold test reads its own Australia-wide wages of ${auWide} cents.`
        : `${members.length} group members aggregated to Australia-wide wages of ${auWide} cents. Only one member may claim the threshold in ${ruleset.jurisdiction}.`,
    outcome: 'resolved',
    inputs: { memberCount: members.length },
  });

  return {
    result: { auWideWages: auWide, wagesByJurisdiction: byJurisdiction, memberCount: members.length },
    trace,
    citations: [],
  };
}
