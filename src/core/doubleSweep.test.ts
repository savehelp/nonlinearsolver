import { afterEach, describe, expect, it, vi } from 'vitest';
import { clone, starter } from '../examples';
import type { Configuration, SweepResult } from './types';
import { configForSlice, DoubleSweepBudget, DoubleSweepMemoryError, secondaryPlan, secondaryValues } from './doubleSweep';
import { normalizeSweep } from './sweepPlan';
import { sweep, sweepSteps } from './solver';
import { mergeSweepUpdate, type WorkerRequest, type WorkerResponse } from './sweepStream';
import { MAX_DOUBLE_SWEEP_SAMPLES, MAX_PARAMETER_SAMPLES, MAX_SECONDARY_SLICES } from './sweepLimits';

function configuration(): Configuration {
  const config = clone(starter);
  config.sweep.points = 5;
  config.sweep.secondary = { parameter: 'a', min: -1, max: 1, points: 3, logarithmic: false };
  return config;
}
function centeredConfiguration(): Configuration {
  const config = configuration();
  Object.assign(config.variables.find(variable => variable.name === 'x')!, { value: 1, min: 0, max: 2, step: 1 });
  Object.assign(config.variables.find(variable => variable.name === 'a')!, { value: 5, min: 0, max: 10, step: 1 });
  return normalizeSweep(config);
}
const withoutTime = (result: SweepResult) => ({ ...result, elapsed: 0 });

describe('second sweep sampling', () => {
  it('solves each level at its exact parameter value while retaining one X axis', () => {
    const config = configuration(); config.axes.x = 'x + 1';
    const original = clone(config);
    expect(secondaryValues(config)).toEqual([-1, 0, 1]);
    for (const value of secondaryValues(config)) {
      const slice = configForSlice(config, value), result = sweep(slice);
      expect(slice.sweep.secondary).toBeUndefined(); expect(slice.axes).toEqual(config.axes);
      for (const point of result.branches.flatMap(branch => branch.points)) {
        expect(point.values.a).toBe(value);
        expect(point.values.y).toBeCloseTo(value * point.parameter);
        expect(point.x).toBeCloseTo(point.parameter + 1);
      }
    }
    expect(config).toEqual(original);
  });

  it('handles logarithmic levels and preserves exact endpoints', () => {
    const config = configuration(); Object.assign(config.sweep.secondary!, { min: .1, max: 10, logarithmic: true });
    const values = secondaryValues(config);
    expect(values[0]).toBe(.1); expect(values[1]).toBeCloseTo(1); expect(values[2]).toBe(10);
    Object.assign(config.sweep.secondary!, { min: 1e-300, max: 1e300 });
    expect(secondaryValues(config).every(Number.isFinite)).toBe(true);
  });

  it('rejects incompatible parameters, unsafe grids, and invalid sampling', () => {
    const edits: ((config: Configuration) => void)[] = [
      config => { config.sweep.secondary!.parameter = 'x'; },
      config => { config.sweep.secondary!.parameter = 'y'; },
      config => { config.sweep.secondary!.parameter = 'deleted'; },
      config => { config.sweep.secondary!.min = 1; },
      config => { config.sweep.secondary!.max = Infinity; },
      config => { config.sweep.secondary!.points = 2.5; },
      config => { config.sweep.secondary!.points = MAX_SECONDARY_SLICES + 1; },
      config => { config.sweep.secondary!.logarithmic = true; },
      config => { config.sweep.points = MAX_PARAMETER_SAMPLES; config.sweep.secondary!.points = 6; },
      config => { config.sweep.points = MAX_PARAMETER_SAMPLES + 1; },
      config => { config.sweep.min = config.sweep.max; },
      config => { config.solver.starts = 0; },
    ];
    for (const edit of edits) { const config = configuration(); edit(config); expect(() => secondaryValues(config)).toThrow(); }
    const constrained = configuration();
    Object.assign(constrained.sweep, { mode: 'constrained', parameter: 'y', release: 'a' });
    expect(() => secondaryValues(constrained)).toThrow('released parameter');
    delete constrained.sweep.secondary; expect(secondaryValues(constrained)).toEqual([]);
  });

  it('rejects levels that round to the same floating point value', () => {
    const config = configuration(); Object.assign(config.sweep.secondary!, { min: 1, max: 1 + Number.EPSILON, points: 3 });
    expect(() => secondaryValues(config)).toThrow('distinct');
  });

  it('derives sorted slices from parameter metadata and starts with the configured value', () => {
    const config = centeredConfiguration(), plan = secondaryPlan(config);
    expect(plan.values).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(plan.startIndex).toBe(5);
    expect(plan.order.map(index => plan.values[index])).toEqual([5, 4, 6, 3, 7, 2, 8, 1, 9, 0, 10]);
    expect(config.sweep.points).toBe(3); expect(config.sweep.secondary!.points).toBe(11);
    expect(configForSlice(config, 4).variables.find(variable => variable.name === 'a')!.value).toBe(4);
    expect(config.variables.find(variable => variable.name === 'a')!.value).toBe(5);
  });

  it('allows step-derived counts above 100 without silently changing the step', () => {
    const config = centeredConfiguration();
    Object.assign(config.variables.find(variable => variable.name === 'a')!, { value: 50, min: 0, max: 100, step: 1 });
    const normalized = normalizeSweep(config), plan = secondaryPlan(normalized);
    expect(plan.values).toHaveLength(101); expect(plan.values[plan.startIndex]).toBe(50);
    Object.assign(config.variables.find(variable => variable.name === 'a')!, { value: 5.2, min: 0, max: 10 });
    const offset = secondaryPlan(normalizeSweep(config));
    expect(offset.order.slice(0, 3).map(index => offset.values[index])).toEqual([5.2, 4.2, 6.2]);
    expect(offset.values.every(value => value >= 0 && value <= 10)).toBe(true);
  });

  it('supports a single step-derived sample but still enforces the grid limit', () => {
    const config = centeredConfiguration();
    config.variables.find(variable => variable.name === 'x')!.step = 20;
    config.variables.find(variable => variable.name === 'a')!.step = 20;
    expect(secondaryValues(normalizeSweep(config))).toEqual([5]);
    Object.assign(config.variables.find(variable => variable.name === 'x')!, { min: 0, max: 500, step: 1, value: 250 });
    Object.assign(config.variables.find(variable => variable.name === 'a')!, { min: 0, max: 500, step: 1, value: 250 });
    expect(() => secondaryPlan(normalizeSweep(config))).toThrow(MAX_DOUBLE_SWEEP_SAMPLES.toLocaleString('en-US'));
    config.variables.find(variable => variable.name === 'a')!.step = 0;
    expect(() => secondaryPlan(normalizeSweep(config))).toThrow();
  });

  it('accepts a full grid at the larger combined limit and rejects one slice beyond it', () => {
    const config = configuration();
    config.sweep.points = MAX_PARAMETER_SAMPLES;
    Object.assign(config.sweep.secondary!, { points: MAX_DOUBLE_SWEEP_SAMPLES / MAX_PARAMETER_SAMPLES });
    expect(secondaryValues(config)).toHaveLength(5);
    config.sweep.secondary!.points++;
    expect(() => secondaryValues(config)).toThrow('250,000');
  });

  it('permits ten thousand selector levels while still validating individual limits', () => {
    const config = configuration(); config.sweep.points = 2;
    config.sweep.secondary!.points = MAX_SECONDARY_SLICES;
    expect(secondaryValues(config)).toHaveLength(10_000);
    config.sweep.secondary!.points++;
    expect(() => secondaryValues(config)).toThrow('10,000');
  });
});

describe('double sweep memory budget', () => {
  it('counts each appended result once and keeps prior slices in the budget', () => {
    const config = configuration(), result = sweep(configForSlice(config, 1)), budget = new DoubleSweepBudget(config);
    budget.startSlice(); const metadata = budget.bytes;
    budget.observe(result); const first = budget.bytes;
    expect(first).toBeGreaterThan(metadata);
    budget.observe(result); expect(budget.bytes).toBe(first);
    budget.startSlice(); budget.observe(result); const second = budget.bytes;
    expect(second - first).toBeGreaterThan(first - metadata);
    const bounded = new DoubleSweepBudget(config, Math.floor((first + second) / 2));
    bounded.startSlice(); bounded.observe(result);
    expect(() => { bounded.startSlice(); bounded.observe(result); }).toThrow(DoubleSweepMemoryError);
  });

  it('includes failure strings and large diagnostic matrices and stops oversized data', () => {
    const config = configuration(), result = sweep(configForSlice(config, 1));
    const budget = new DoubleSweepBudget(config, 30000); budget.startSlice();
    result.branches[0].points[0].jacobian = Array.from({ length: 50 }, () => Array(50).fill(1));
    expect(() => budget.observe(result)).toThrow('memory budget');
    const failures = new DoubleSweepBudget(config, 30000); failures.startSlice();
    result.branches = []; result.failures = [{ index: 0, parameter: 0, reason: 'x'.repeat(30000) }];
    expect(() => failures.observe(result)).toThrow(DoubleSweepMemoryError);
  });

  it('accounts only new sample data when steep curves create many singleton branches', () => {
    // Piecewise sources retain jump detection; fully affine curves now have a
    // proven unique direct solution and correctly continue as one branch.
    const config = configuration(); config.equations = 'y = if(x < 0, 1000*x, 1000*x);'; config.sweep.points = 41;
    const slice = configForSlice(config, 1), budget = new DoubleSweepBudget(config), sampleCounts: number[] = [];
    budget.startSlice();
    const steps = sweepSteps(slice, Infinity, (_result, sample) => {
      sampleCounts.push(sample.points.length); budget.observeSample(sample);
    });
    const final = steps.next();
    expect(final.done).toBe(true); expect(final.value.result.branches).toHaveLength(41);
    expect(sampleCounts).toEqual(Array(41).fill(1));
    const beforeFinal = budget.bytes; budget.observe(final.value.result); expect(budget.bytes).toBe(beforeFinal);
    const full = new DoubleSweepBudget(config); full.startSlice(); full.observe(final.value.result);
    expect(budget.bytes).toBe(full.bytes);
  });

  it('matches full accounting for sample failures and checks the budget before a progress yield', () => {
    const config = configuration(); config.axes.y = 'sqrt(x), y';
    const budget = new DoubleSweepBudget(config); budget.startSlice();
    const steps = sweepSteps(configForSlice(config, 1), Infinity, (_result, sample) => budget.observeSample(sample));
    const final = steps.next();
    const full = new DoubleSweepBudget(config); full.startSlice(); full.observe(final.value.result);
    expect(final.value.result.failures.length).toBeGreaterThan(0); expect(budget.bytes).toBe(full.bytes);
    const limited = new DoubleSweepBudget(config, full.bytes - 1); limited.startSlice();
    expect(() => sweepSteps(configForSlice(config, 1), Infinity, (_result, sample) => limited.observeSample(sample)).next()).toThrow(DoubleSweepMemoryError);
  });

  it('reserves sampling arrays and transfer bookkeeping before a large run starts', () => {
    const small = configuration(), large = clone(small);
    large.sweep.points = MAX_PARAMETER_SAMPLES;
    large.sweep.secondary!.points = MAX_SECONDARY_SLICES;
    const before = new DoubleSweepBudget(small).bytes;
    const after = new DoubleSweepBudget(large).bytes;
    expect(after - before).toBe(64 * (MAX_PARAMETER_SAMPLES - small.sweep.points + MAX_SECONDARY_SLICES - small.sweep.secondary!.points));
  });
});

describe('double sweep worker', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function worker(acknowledge = true) {
    vi.resetModules();
    const solver = await import('./solver'), original = solver.sweepSteps;
    vi.spyOn(solver, 'sweepSteps').mockImplementation((config, _interval, observe) => original(config, 0, observe));
    const messages: WorkerResponse[] = [];
    const host: { postMessage: (message: WorkerResponse) => void; onmessage?: (event: MessageEvent<WorkerRequest>) => void } = {
      postMessage: message => {
        messages.push(message);
        if (acknowledge && (message.type === 'slice-progress' || message.type === 'slice-complete' || message.type === 'slice-error')) {
          setTimeout(() => host.onmessage!({ data: { type: 'ack', id: message.id } } as MessageEvent<WorkerRequest>), 0);
        }
      },
    };
    vi.stubGlobal('self', host); vi.useFakeTimers();
    await import('./worker');
    const send = (message: WorkerRequest) => host.onmessage!({ data: message } as MessageEvent<WorkerRequest>);
    return { messages, send };
  }

  it('assembles the full grid without duplicating points or changing per-slice results', async () => {
    const config = configuration(), { messages, send } = await worker();
    send({ type: 'run', id: 1, config }); await vi.runAllTimersAsync();
    expect(messages.at(-1)).toMatchObject({ type: 'double-complete', id: 1, totalSlices: 3 });
    const results = new Map<number, SweepResult>();
    for (const message of messages) {
      if (message.type === 'slice-complete' || message.type === 'slice-progress') {
        results.set(message.sliceIndex, mergeSweepUpdate(results.get(message.sliceIndex) ?? null, message.update));
      }
    }
    expect(results.size).toBe(3);
    secondaryValues(config).forEach((value, index) => {
      expect(withoutTime(results.get(index)!)).toEqual(withoutTime(sweep(configForSlice(config, value))));
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('computes centered slices outward while keeping their selector positions sorted', async () => {
    const config = centeredConfiguration(), { messages, send } = await worker();
    send({ type: 'run', id: 10, config }); await vi.runAllTimersAsync();
    const completed = messages.filter((message): message is Extract<WorkerResponse, { type: 'slice-progress' | 'slice-complete' }> => message.type === 'slice-complete');
    expect(completed.map(message => message.value)).toEqual([5, 4, 6, 3, 7, 2, 8, 1, 9, 0, 10]);
    expect(completed.map(message => message.sliceIndex)).toEqual([5, 4, 6, 3, 7, 2, 8, 1, 9, 0, 10]);
    const assembled = new Map<number, SweepResult>();
    for (const message of messages) if (message.type === 'slice-complete' || message.type === 'slice-progress') {
      assembled.set(message.sliceIndex, mergeSweepUpdate(assembled.get(message.sliceIndex) ?? null, message.update));
    }
    for (const [index, result] of assembled) {
      expect(withoutTime(result)).toEqual(withoutTime(sweep(configForSlice(config, index))));
      expect(result.branches.flatMap(branch => branch.points).every(point => point.values.a === index)).toBe(true);
    }
    expect(messages.at(-1)).toMatchObject({ type: 'double-complete', totalSlices: 11 });
    expect(config.variables.find(variable => variable.name === 'a')!.value).toBe(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains a centered slice failure at its own sorted index and continues outward', async () => {
    const config = centeredConfiguration(); config.equations = 'y^2 = a;';
    Object.assign(config.variables.find(variable => variable.name === 'a')!, { value: 0, min: -1, max: 1, step: 1 });
    const { messages, send } = await worker(); send({ type: 'run', id: 11, config: normalizeSweep(config) });
    await vi.runAllTimersAsync();
    const finished = messages.filter(message => message.type === 'slice-complete' || message.type === 'slice-error');
    expect(finished.map(message => 'value' in message ? message.value : NaN)).toEqual([0, -1, 1]);
    expect(finished[1]).toMatchObject({ type: 'slice-error', sliceIndex: 0, value: -1 });
    expect(finished[2]).toMatchObject({ type: 'slice-complete', sliceIndex: 2, value: 1 });
    expect(messages.at(-1)).toMatchObject({ type: 'double-complete', totalSlices: 3 });
  });

  it('records a failed level independently and continues computing valid levels', async () => {
    const config = configuration(); config.equations = 'y^2 = a;';
    const { messages, send } = await worker(); send({ type: 'run', id: 2, config }); await vi.runAllTimersAsync();
    expect(messages.filter(message => message.type === 'slice-error')).toEqual([
      { type: 'slice-error', id: 2, sliceIndex: 0, value: -1, error: expect.stringContaining('No points') },
    ]);
    expect(messages.filter(message => message.type === 'slice-complete')).toHaveLength(2);
    expect(messages.at(-1)).toMatchObject({ type: 'double-complete', totalSlices: 3 });
  });

  it('waits for each slice acknowledgement and discards a replaced run', async () => {
    const config = configuration(), { messages, send } = await worker(false);
    send({ type: 'run', id: 3, config }); await vi.runAllTimersAsync();
    expect(messages.map(message => message.type)).toEqual(['slice-progress']);
    send({ type: 'ack', id: 3 }); await vi.runAllTimersAsync();
    expect(messages.filter(message => message.type === 'slice-complete')).toHaveLength(1);
    expect(messages.filter(message => 'sliceIndex' in message && message.sliceIndex > 0)).toHaveLength(0);
    // A new request also releases any promise waiting on the old request's ACK.
    send({ type: 'run', id: 4, config }); await vi.runAllTimersAsync();
    for (let attempt = 0; attempt < 10 && messages.at(-1)?.type !== 'double-complete'; attempt++) {
      send({ type: 'ack', id: 4 }); await vi.runAllTimersAsync();
    }
    expect(messages.some(message => message.id === 3 && message.type === 'double-complete')).toBe(false);
    expect(messages.at(-1)).toMatchObject({ type: 'double-complete', id: 4 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports shared configuration and budget errors as fatal errors', async () => {
    const config = configuration(), { messages, send } = await worker();
    const invalid = clone(config); invalid.equations = 'y = missing;';
    send({ type: 'run', id: 5, config: invalid }); await vi.runAllTimersAsync();
    expect(messages).toEqual([{ type: 'error', id: 5, error: expect.stringContaining('not defined') }]);
    messages.length = 0;
    const memory = await import('./doubleSweep');
    vi.spyOn(memory.DoubleSweepBudget.prototype, 'observeSample').mockImplementation(() => { throw new memory.DoubleSweepMemoryError(); });
    send({ type: 'run', id: 6, config }); await vi.runAllTimersAsync();
    expect(messages).toEqual([{ type: 'error', id: 6, error: expect.stringContaining('memory budget') }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('applies the same per-sample memory guard to a single sweep before any preview is sent', async () => {
    const config = configuration(); delete config.sweep.secondary;
    const { messages, send } = await worker();
    const memory = await import('./doubleSweep');
    const guard = vi.spyOn(memory.SweepBudget.prototype, 'observeSample').mockImplementation(() => { throw new memory.SweepMemoryError(); });
    send({ type: 'run', id: 12, config }); await vi.runAllTimersAsync();
    expect(guard).toHaveBeenCalledOnce();
    expect(messages).toEqual([{ type: 'error', id: 12, error: expect.stringContaining('The sweep exceeds its memory budget') }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
