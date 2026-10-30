export function formatValue(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  return Math.abs(value) < .001 || Math.abs(value) >= 10000
    ? value.toExponential(3)
    : Number(value.toPrecision(6)).toString();
}
