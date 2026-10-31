import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clone, starter } from '../examples';
import { SweepRunner, type SweepEvent, type SweepWorker } from './sweepRunner';
import type { SweepResult } from './types';
import type { WorkerRequest, WorkerResponse } from './sweepStream';
import { sweep } from './solver';
import { normalizeSweep } from './sweepPlan';

class FakeWorker implements SweepWorker {
  onmessage: SweepWorker['onmessage'] = null;
  onerror: SweepWorker['onerror'] = null;
  postMessage = vi.fn<(message: WorkerRequest) => void>();
  terminate = vi.fn();
  get id() { return this.postMessage.mock.calls[0][0].id; }
  respond(message: WorkerResponse) {
    this.onmessage?.({ data: message } as MessageEvent<WorkerResponse>);
  }
  send(type: 'progress' | 'complete', result = resultAt(0), completed = result.total) {
    this.respond({ type, id: this.id, update: { ...result, completed } });
  }
  slice(type: 'slice-progress' | 'slice-complete', sliceIndex: number, value: number, result = resultAt(0), completed = result.total) {
    this.respond({ type, id: this.id, sliceIndex, value, update: { ...result, completed } });
  }
}
function resultAt(index: number, value = index): SweepResult {
  return {
    branches: [{ id: 1, points: [{ index, branch: 1, x: index, y: value, ys: [value], parameter: index, values: { x: index, y: value }, residuals: [0], norm: 0, iterations: 1, jacobian: [[1]], region: '' }] }],
    failures: [], solved: index + 1, total: 5, elapsed: 1, unknowns: ['y'], equations: ['y = x'],
  };
}
function setup() {
  const events: SweepEvent[] = [], workers: FakeWorker[] = [];
  const factory = vi.fn(() => { const worker = new FakeWorker(); workers.push(worker); return worker; });
  const runner = new SweepRunner(factory, event => events.push(event));
  return { runner, events, workers, factory };
}
function doubleConfig() {
  const config = clone(starter);
  config.sweep.secondary = { parameter: 'a', min: 1, max: 3, points: 3, logarithmic: false };
  return config;
}

describe('sweep lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces new values and starts only the latest configuration', () => {
    const { runner, workers, factory } = setup(), config = clone(starter);
    runner.run(config); vi.advanceTimersByTime(100);
    const next = clone(config); next.variables[0].value = 2;
    runner.run(next); vi.advanceTimersByTime(219); expect(factory).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(factory).toHaveBeenCalledTimes(1);
    expect(workers[0].postMessage).toHaveBeenCalledWith({ type: 'run', id: workers[0].id, config: next });
    runner.cancel(); expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it('recomputes ordinary sweeps even after returning to a previously completed value', () => {
    const { runner, workers, events, factory } = setup(), a = clone(starter), b = clone(starter);
    b.variables[2].value = 3;
    runner.run(a); vi.advanceTimersByTime(220); workers[0].send('complete');
    runner.run(b); vi.advanceTimersByTime(220); workers[1].send('complete');
    runner.run(a); expect(events.at(-1)).toEqual({ type: 'pending' });
    expect(factory).toHaveBeenCalledTimes(2); vi.advanceTimersByTime(220);
    expect(factory).toHaveBeenCalledTimes(3); workers[2].send('complete');
    expect(events.at(-1)).toMatchObject({ type: 'result', config: a, complete: true });
    expect(events.at(-1)).not.toHaveProperty('cached');
    expect(workers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true);
  });

  it('acknowledges previews and appends only new points to a final single sweep', () => {
    const { runner, workers, events } = setup(), config = clone(starter);
    runner.run(config, 0); vi.advanceTimersByTime(0); workers[0].send('progress', resultAt(0), 1);
    const preview = events.at(-1);
    expect(preview).toMatchObject({ type: 'result', complete: false, completed: 1 });
    expect(workers[0].postMessage).toHaveBeenLastCalledWith({ type: 'ack', id: workers[0].id });
    expect(workers[0].terminate).not.toHaveBeenCalled();
    workers[0].send('complete', resultAt(1), 5);
    const complete = events.at(-1);
    if (complete?.type !== 'result' || preview?.type !== 'result') throw new Error('Expected result events');
    expect(complete.result.branches[0].points.map(point => point.index)).toEqual([0, 1]);
    expect(preview.result.branches[0].points).toHaveLength(1);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });

  it('passes only matching successful sample seeds to the next worker on resampling', () => {
    const { runner, workers } = setup(), initial = clone(starter);
    initial.axes = { x: 'x', y: '0' };
    Object.assign(initial.variables.find(variable => variable.name === 'x')!, { min: 0, max: 4, value: 0, step: 1 });
    const before = normalizeSweep(initial), result = sweep(before), next = clone(before);
    next.variables.find(variable => variable.name === 'x')!.step = 2;
    runner.run(normalizeSweep(next), 0, { config: before, slices: [{ values: {}, result }] });
    vi.advanceTimersByTime(0);
    const request = workers[0].postMessage.mock.calls[0][0];
    if (request.type !== 'run') throw new Error('Expected a run request');
    expect(request.reuse?.samples.map(sample => sample.coordinates)).toEqual([[0], [2], [4]]);
    expect(request.reuse!.bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    runner.cancel();
  });

  it('keeps double-sweep slices separate and the worker alive until the entire grid finishes', () => {
    const { runner, workers, events } = setup(), config = doubleConfig();
    runner.run(config, 0); vi.advanceTimersByTime(0); const worker = workers[0];
    worker.slice('slice-progress', 0, 1, resultAt(0, 10), 1);
    worker.slice('slice-complete', 0, 1, resultAt(1, 11), 5);
    worker.slice('slice-complete', 1, 2, resultAt(0, 20), 5);
    const slices = events.filter((event): event is Extract<SweepEvent, { type: 'slice' }> => event.type === 'slice');
    expect(slices.map(event => [event.index, event.value, event.complete])).toEqual([[0, 1, false], [0, 1, true], [1, 2, true]]);
    expect(slices[1].result.branches[0].points.map(point => point.y)).toEqual([10, 11]);
    expect(slices[2].result.branches[0].points.map(point => point.y)).toEqual([20]);
    expect(slices[0].result.branches[0].points.map(point => point.y)).toEqual([10]);
    expect(worker.postMessage.mock.calls.filter(([message]) => message.type === 'ack')).toHaveLength(3);
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.respond({ type: 'double-complete', id: worker.id, totalSlices: 3, elapsed: 900 });
    expect(events.at(-1)).toEqual({ type: 'double-complete', config, totalSlices: 3, elapsed: 900 });
    expect(worker.terminate).toHaveBeenCalledOnce(); expect(worker.onmessage).toBeNull();
  });

  it('discards a failed slice preview and continues with later slices', () => {
    const { runner, workers, events } = setup(), config = doubleConfig();
    runner.run(config, 0); vi.advanceTimersByTime(0); const worker = workers[0];
    worker.slice('slice-progress', 0, 1, resultAt(0, 10), 1);
    worker.respond({ type: 'slice-error', id: worker.id, sliceIndex: 0, value: 1, error: 'No points' });
    expect(events.at(-1)).toEqual({ type: 'slice-error', config, index: 0, value: 1, error: 'No points' });
    expect(worker.terminate).not.toHaveBeenCalled();
    worker.slice('slice-complete', 1, 2, resultAt(0, 20), 5);
    const next = events.at(-1);
    if (next?.type !== 'slice') throw new Error('Expected next slice');
    expect(next.result.branches[0].points.map(point => point.y)).toEqual([20]);
    expect(worker.postMessage.mock.calls.filter(([message]) => message.type === 'ack')).toHaveLength(3);
    runner.cancel();
  });

  it('ignores old queued progress, completion, and errors after cancellation', () => {
    const { runner, workers, events } = setup(), config = doubleConfig();
    runner.run(config, 0); vi.advanceTimersByTime(0);
    const oldMessage = workers[0].onmessage!, oldError = workers[0].onerror!, oldId = workers[0].id;
    runner.cancel(); runner.run(starter, 0); vi.advanceTimersByTime(0); const before = events.length;
    oldMessage({ data: { type: 'slice-complete', id: oldId, sliceIndex: 0, value: 1, update: { ...resultAt(0), completed: 5 } } } as MessageEvent<WorkerResponse>);
    oldMessage({ data: { type: 'double-complete', id: oldId, totalSlices: 3, elapsed: 900 } } as MessageEvent<WorkerResponse>);
    oldError({ message: 'Old worker failed' } as ErrorEvent);
    expect(events).toHaveLength(before);
    expect(workers[0].onmessage).toBeNull(); expect(workers[0].onerror).toBeNull();
    workers[1].send('complete'); expect(events.at(-1)).toMatchObject({ type: 'result', complete: true });
  });

  it('reports worker errors once, clears their handlers, and allows a retry', () => {
    const { runner, workers, events, factory } = setup(), config = clone(starter);
    runner.run(config, 0); vi.advanceTimersByTime(0);
    const queuedError = workers[0].onerror!;
    workers[0].respond({ type: 'error', id: workers[0].id, error: 'No roots' });
    queuedError({ message: 'Later failure' } as ErrorEvent);
    expect(events.filter(event => event.type === 'error')).toEqual([{ type: 'error', config, error: 'No roots' }]);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    runner.run(config, 0); vi.advanceTimersByTime(0); expect(factory).toHaveBeenCalledTimes(2);
    runner.cancel();
  });

  it('handles a worker that cannot start and cancels pending debounce timers', () => {
    const events: SweepEvent[] = [], runner = new SweepRunner(() => { throw new Error('Unavailable'); }, event => events.push(event));
    runner.run(starter); runner.cancel(); vi.runAllTimers(); expect(events.map(event => event.type)).toEqual(['pending']);
    runner.run(starter, 0); vi.runAllTimers(); expect(events.at(-1)).toMatchObject({ type: 'error', error: 'Unavailable' });
  });
});
