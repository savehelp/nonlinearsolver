import type { Branch, Configuration, Point, SweepResult } from './types';
import type { SampleReuseData } from './sampleReuse';

/** Branches and failures contain only data not sent by earlier updates. */
export interface SweepUpdate extends SweepResult { completed: number }
export type WorkerRequest = { type: 'run'; id: number; config: Configuration; reuse?: SampleReuseData } | { type: 'ack'; id: number };
export type WorkerResponse = { type: 'progress' | 'complete'; id: number; update: SweepUpdate }
  | { type: 'slice-progress' | 'slice-complete'; id: number; sliceIndex: number; value: number; update: SweepUpdate }
  | { type: 'slice-error'; id: number; sliceIndex: number; value: number; error: string }
  | { type: 'double-complete'; id: number; elapsed: number; totalSlices: number }
  | { type: 'error'; id: number; error: string };

/** Remember sample indices rather than copying prior points or large Jacobians.
 * Centered sweeps can extend either end of an existing branch. */
export function createSweepUpdates(): (result: SweepResult, completed: number) => SweepUpdate {
  const sent = new Map<number, Set<number>>();
  let sentFailures = 0;
  return (result, completed) => {
    const branches: Branch[] = [];
    for (const branch of result.branches) {
      const indices = sent.get(branch.id) ?? new Set<number>();
      const points = branch.points.filter(point => !indices.has(point.index));
      if (points.length) {
        branches.push({ id: branch.id, points });
        points.forEach(point => indices.add(point.index));
        sent.set(branch.id, indices);
      }
    }
    const failures = result.failures.slice(sentFailures);
    sentFailures = result.failures.length;
    return { ...result, branches, failures, completed };
  };
}

/** Merge sorted sample positions without reconnecting across an unsolved gap. */
function mergePoints(previous: Point[], additions: Point[]): Point[] {
  if (!previous.length) return additions;
  if (!additions.length) return previous;
  if (previous[previous.length - 1].index < additions[0].index) return [...previous, ...additions];
  if (additions[additions.length - 1].index < previous[0].index) return [...additions, ...previous];
  const points: Point[] = [];
  let old = 0, next = 0;
  while (old < previous.length && next < additions.length) {
    if (previous[old].index < additions[next].index) points.push(previous[old++]);
    else points.push(additions[next++]);
  }
  return points.concat(previous.slice(old), additions.slice(next));
}

/** Preserve old snapshots and point objects while inserting each delta once. */
export function mergeSweepUpdate(previous: SweepResult | null, update: SweepUpdate): SweepResult {
  const branches = previous?.branches.slice() ?? [];
  const indices = new Map(branches.map((branch, index) => [branch.id, index]));
  for (const addition of update.branches) {
    const index = indices.get(addition.id);
    if (index === undefined) {
      indices.set(addition.id, branches.length);
      branches.push({ id: addition.id, points: addition.points });
    } else {
      const branch = branches[index];
      branches[index] = { id: branch.id, points: mergePoints(branch.points, addition.points) };
    }
  }
  return {
    branches,
    failures: update.failures.length ? [...(previous?.failures ?? []), ...update.failures] : previous?.failures ?? [],
    solved: update.solved, total: update.total, elapsed: update.elapsed,
    unknowns: update.unknowns, equations: update.equations,
    ...(update.computed === undefined ? {} : { computed: update.computed }),
    ...(update.reused === undefined ? {} : { reused: update.reused }),
  };
}
