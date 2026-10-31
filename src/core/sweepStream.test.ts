import { describe, expect, it, vi } from 'vitest';
import { clone, examples, starter } from '../examples';
import { sweep, sweepSteps } from './solver';
import * as solver from './solver';
import { createSweepUpdates, mergeSweepUpdate, type SweepUpdate, type WorkerRequest, type WorkerResponse } from './sweepStream';
import type { Configuration, SweepResult } from './types';

const withoutTime = (result: SweepResult) => ({ ...result, elapsed: 0 });

function streamed(config: Configuration) {
  const steps = sweepSteps(config, 0), delta = createSweepUpdates();
  const updates: SweepUpdate[] = [], snapshots: SweepResult[] = [];
  let assembled: SweepResult | null = null;
  let step = steps.next();
  while (true) {
    const update = delta(step.value.result, step.value.completed);
    updates.push(update);
    assembled = mergeSweepUpdate(assembled, update);
    snapshots.push(assembled);
    if (step.done) break;
    step = steps.next();
  }
  return { result: assembled!, updates, snapshots };
}

describe('incremental sweeps', () => {
  it('assembles each point once and leaves earlier previews unchanged', () => {
    const config = clone(starter); config.sweep = { ...config.sweep, min: 0, max: .6, points: 7 };
    const normal = sweep(config), { result, updates, snapshots } = streamed(config);
    expect(withoutTime(result)).toEqual(withoutTime(normal));
    expect(updates.map(update => update.completed)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(updates.every(update => update.total === 7)).toBe(true);
    expect(updates.flatMap(update => update.branches.flatMap(branch => branch.points))).toHaveLength(7);
    expect(snapshots[0].branches[0].points).toHaveLength(1);
    expect(snapshots[0].branches[0].points[0]).toBe(result.branches[0].points[0]);
    expect(snapshots[0].branches[0].points).not.toBe(result.branches[0].points);
    expect(updates.at(-1)!.elapsed).toBeGreaterThanOrEqual(updates[0].elapsed);
  });

  it('preserves multiple branches and their creation order', () => {
    const config = clone(examples[2]); config.sweep.points = 21;
    const { result } = streamed(config);
    expect(result.branches.length).toBeGreaterThan(1);
    expect(withoutTime(result)).toEqual(withoutTime(sweep(config)));
    const atCenter = result.branches.flatMap(branch => branch.points.filter(point => point.index === 10));
    expect(atCenter).toHaveLength(3);
  });

  it('preserves failed sample gaps and reports processed rather than solved counts', () => {
    const config = clone(starter);
    config.equations = 'y^2 = x^2 - 0.1;';
    config.variables = [{ name: 'y', kind: 'unknown', value: .8, min: -5, max: 5 }, { name: 'x', kind: 'parameter', value: 0 }];
    config.sweep = { ...config.sweep, min: -1, max: 1, points: 11 };
    const { result, updates } = streamed(config);
    expect(withoutTime(result)).toEqual(withoutTime(sweep(config)));
    expect(result.failures.length).toBeGreaterThan(0);
    expect(updates.some(update => update.completed > update.solved)).toBe(true);
    expect(updates.flatMap(update => update.failures)).toHaveLength(result.failures.length);
    for (const branch of result.branches) {
      expect(branch.points.every(point => point.parameter < 0) || branch.points.every(point => point.parameter > 0)).toBe(true);
    }
  });

  it('preserves null Y values and axis diagnostics alongside valid series', () => {
    const config = clone(starter); config.axes.y = 'sqrt(x), y'; config.sweep.points = 9;
    const { result } = streamed(config);
    expect(withoutTime(result)).toEqual(withoutTime(sweep(config)));
    expect(result.branches.flatMap(branch => branch.points).some(point => point.ys[0] === null)).toBe(true);
    expect(result.failures.some(failure => failure.reason.includes('Y expression'))).toBe(true);
  });

  it('supports a final update with no additional points or failures', () => {
    const config = clone(starter); config.sweep.points = 3;
    const result = sweep(config), delta = createSweepUpdates();
    const first = delta(result, 3), final = delta(result, 3);
    expect(final.branches).toEqual([]);
    expect(final.failures).toEqual([]);
    expect(mergeSweepUpdate(mergeSweepUpdate(null, first), final)).toEqual(result);
  });

  it('skips intermediate messages for fast sweeps and retains configuration errors', () => {
    const config = clone(starter); config.sweep.points = 3;
    const steps = sweepSteps(config, Infinity), step = steps.next();
    expect(step.done).toBe(true);
    expect(step.value.completed).toBe(3);
    config.equations = 'y = missing;';
    expect(() => sweepSteps(config, 0).next()).toThrow('Underdetermined');
  });

  it('bounds unacknowledged worker progress and sends the remaining final delta', async () => {
    const config = clone(starter); config.sweep.points = 7;
    const expected = sweep(config), original = solver.sweepSteps;
    vi.spyOn(solver, 'sweepSteps').mockImplementation(config => original(config, 0));
    const messages: WorkerResponse[] = [];
    let acknowledge = false;
    const host: { postMessage: (message: WorkerResponse) => void; onmessage?: (event: MessageEvent<WorkerRequest>) => void } = {
      postMessage: message => {
        messages.push(message);
        if (acknowledge && message.type === 'progress') {
          setTimeout(() => host.onmessage!({ data: { type: 'ack', id: message.id } } as MessageEvent<WorkerRequest>), 0);
        }
      },
    };
    vi.stubGlobal('self', host);
    vi.useFakeTimers();
    try {
      await import('./worker');
      host.onmessage!({ data: { type: 'run', id: 4, config } } as MessageEvent<WorkerRequest>);
      await vi.runAllTimersAsync();
      expect(messages.map(message => message.type)).toEqual(['progress', 'complete']);
      let assembled: SweepResult | null = null;
      for (const message of messages) {
        expect(message.id).toBe(4);
        if ('update' in message) assembled = mergeSweepUpdate(assembled, message.update);
      }
      expect(withoutTime(assembled!)).toEqual(withoutTime(expected));

      messages.length = 0;
      host.onmessage!({ data: { type: 'run', id: 5, config } } as MessageEvent<WorkerRequest>);
      host.onmessage!({ data: { type: 'ack', id: 4 } } as MessageEvent<WorkerRequest>);
      await vi.runAllTimersAsync();
      expect(messages.map(message => message.type)).toEqual(['progress', 'complete']);
      expect(messages.every(message => message.id === 5)).toBe(true);

      messages.length = 0;
      acknowledge = true;
      host.onmessage!({ data: { type: 'run', id: 6, config } } as MessageEvent<WorkerRequest>);
      await vi.runAllTimersAsync();
      expect(messages.filter(message => message.type === 'progress')).toHaveLength(6);
      expect(messages.filter(message => message.type === 'complete')).toHaveLength(1);
      expect(messages.flatMap(message => !('update' in message) ? [] : message.update.branches.flatMap(branch => branch.points.map(point => point.index)))).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(vi.getTimerCount()).toBe(0);

      messages.length = 0;
      const invalid = clone(config); invalid.equations = 'y = missing;';
      host.onmessage!({ data: { type: 'run', id: 7, config: invalid } } as MessageEvent<WorkerRequest>);
      await vi.runAllTimersAsync();
      expect(messages).toEqual([{ type: 'error', id: 7, error: expect.stringContaining('Underdetermined') }]);
      expect(vi.getTimerCount()).toBe(0);

      messages.length = 0;
      host.onmessage!({ data: { type: 'run', id: 8, config } } as MessageEvent<WorkerRequest>);
      host.onmessage!({ data: { type: 'run', id: 9, config } } as MessageEvent<WorkerRequest>);
      await vi.runAllTimersAsync();
      expect(messages.filter(message => message.id === 8).map(message => message.type)).toEqual(['progress']);
      expect(messages.at(-1)?.type).toBe('complete');
      expect(messages.at(-1)?.id).toBe(9);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
});
