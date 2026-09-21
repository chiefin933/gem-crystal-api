/** Compare Kenyan-shilling amounts as integer cents, never floating-point values. */
export function kesToCents(value: unknown): number | null {
  const text = value && typeof value === 'object' && 'toFixed' in value
    ? (value as { toFixed: (digits: number) => string }).toFixed(2)
    : String(value);
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;

  const whole = Number(match[1]);
  if (!Number.isSafeInteger(whole)) return null;
  const fractional = Number((match[2] ?? '').padEnd(2, '0'));
  const cents = whole * 100 + fractional;
  return Number.isSafeInteger(cents) ? cents : null;
}

export function hasSameKesAmount(left: unknown, right: unknown): boolean {
  const leftCents = kesToCents(left);
  const rightCents = kesToCents(right);
  return leftCents !== null && leftCents === rightCents;
}
