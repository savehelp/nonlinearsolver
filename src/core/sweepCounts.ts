export type SampleCount = number | bigint;

/** Products of representable integer axis counts remain exact even when their
 * total is larger than Number.MAX_SAFE_INTEGER. No per-sample storage is used. */
export function sampleProduct(counts: readonly number[]): SampleCount {
  if (counts.some(count => !(count > 0) || !Number.isInteger(count))) return counts.some(count => count === Infinity) ? Infinity : 0;
  if (counts.every(Number.isSafeInteger)) {
    const product = counts.reduce((value, count) => value * BigInt(count), 1n);
    return product <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(product) : product;
  }
  return counts.reduce((value, count) => value * count, 1);
}

export function formatSampleCount(count: SampleCount): string {
  if (typeof count === 'bigint') return count.toLocaleString('en-US');
  if (count === Infinity) return 'beyond the finite numeric range';
  if (!Number.isFinite(count) || count < 0) return 'unavailable';
  return Number.isSafeInteger(count) ? count.toLocaleString('en-US') : `approximately ${count.toExponential(6)}`;
}

export function sampleCountExceeds(count: SampleCount, limit: number): boolean {
  return typeof count === 'bigint' ? count > BigInt(limit) : count > limit;
}

export interface SampleAxis { name: string; count: number }

export function gridLimitMessage(axes: readonly SampleAxis[], limit: number): string {
  const product = sampleProduct(axes.map(axis => axis.count));
  const breakdown = axes.map(axis => `${axis.name}: ${formatSampleCount(axis.count)}`).join(' × ');
  let suggestion = 'Increase parameter step sizes or narrow ranges.';
  const largest = axes.reduce<SampleAxis | undefined>((selected, axis) => !selected || axis.count > selected.count ? axis : selected, undefined);
  if (largest) {
    const other = sampleProduct(axes.filter(axis => axis !== largest).map(axis => axis.count));
    const allowed = typeof other === 'bigint' ? Number(BigInt(limit) / other) : Math.floor(limit / other);
    if (allowed > 0) suggestion = `With the other axes unchanged, reduce ${largest.name} to at most ${formatSampleCount(allowed)} samples by increasing its step or narrowing its range.`;
    else suggestion = 'Reduce counts on multiple axes by increasing their steps or narrowing their ranges.';
  }
  return `The sweep grid requests ${formatSampleCount(product)} samples; the limit is ${formatSampleCount(limit)} samples. ${breakdown}. ${suggestion}`;
}
