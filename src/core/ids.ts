let counter = 0;
/** Unique-enough id for UI-created objects (not used for deterministic generation). */
export function uid(prefix = 'id'): string {
  counter = (counter + 1) % 1e6;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

/** Deterministic id factory used by the generator so seeds reproduce exactly. */
export function idFactory(prefix: string) {
  let n = 0;
  return (kind = 'e') => `${prefix}-${kind}${(n++).toString(36)}`;
}
