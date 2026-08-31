import type { Maybe, SourcedValue, Unsourced } from '../src/sourced-value.ts';
import { isSourced } from '../src/sourced-value.ts';

/**
 * Assertion helpers for the sourcing state of a ruleset field.
 *
 * These exist because `assert.ok(isSourced(x))` does not narrow `x`: Node's `assert.ok`
 * is declared `asserts value`, which narrows a reference passed directly, not the result
 * of an inline boolean expression. The test then reads `x.value` and the compiler is
 * right to object. A real assertion function fixes it, and reads better besides.
 */

export function mustBeSourced<T>(v: Maybe<T>, label: string): asserts v is SourcedValue<T> {
  if (!isSourced(v)) {
    throw new Error(`${label} must be sourced, but is not. Reason on file: ${v.unsourced_reason}`);
  }
}

export function mustBeUnsourced<T>(v: Maybe<T>, label: string): asserts v is Unsourced {
  if (isSourced(v)) {
    throw new Error(`${label} must be unsourced, but carries a value: ${String(v.value)}`);
  }
}

/** Narrow a `find` result, failing the test rather than deferencing undefined. */
export function mustExist<T>(v: T | undefined, label: string): T {
  if (v === undefined) throw new Error(`${label} was expected but not found`);
  return v;
}
