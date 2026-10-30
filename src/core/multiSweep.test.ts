import { afterEach, describe, expect, it, vi } from 'vitest';
import { clone, starter } from '../examples';
import { configForCombination, DEFAULT_DOUBLE_SWEEP_BYTES, DoubleSweepBudget, DoubleSweepMemoryError, multiSweepPlan } from './doubleSweep';
import { normalizeSweep } from './sweepPlan';
import { sweep } from './solver';
import { mergeSweepUpdate, type WorkerRequest, type WorkerResponse } from './sweepStream';
import type { Configuration, SweepResult } from './types';

function configuration(): Configuration {
  const config = clone(starter);
  config.equations = 'y = a*x + b + c;';
  config.axes.x = 'x + 0.5';
  config.variables.push({ name: 'c', kind: 'parameter', value: 1, min: 0, max: 2, step: 1 });
  for (const variable of config.variables.filter(variable => variable.kind === 'parameter')) {
    Object.assign(variable, { value: 1, min: 0, max: 2, step: 1 });
  }
  const dimension = (parameter: string) => ({ parameter, min: 0, max: 2, points: 3, logarithmic: false });
  config.sweep.secondary = dimension('a');
  config.sweep.additional = [dimension('b'), dimension('c')];
  return normalizeSweep(config);
}

describe('multiple additional sweep parameters', () => {
  it('indexes all combinations independently and substitutes only the swept fixed parameters', () => {
    const config = configuration(), original = clone(config), plan = multiSweepPlan(config);
    expect(plan.dimensions.map(dimension => dimension.parameter)).toEqual(['a', 'b', 'c']);
    expect(plan.strides).toEqual([1, 3, 9]);
    expect(plan.mainPoints).toBe(3); expect(plan.totalSlices).toBe(27);
    expect(plan.startIndices).toEqual([1, 1, 1]); expect(plan.startIndex).toBe(13);
    for (let index = 0; index < plan.totalSlices; index++) {
      expect(plan.indexOf(plan.indicesAt(index))).toBe(index);
      const values = plan.valuesAt(index), slice = configForCombination(config, { ...values, x: 999, y: 999 });
      expect(slice.sweep.secondary).toBeUndefined(); expect(slice.sweep.additional).toBeUndefined();
      expect(slice.axes).toEqual(config.axes);
      expect(slice.variables.find(variable => variable.name === 'x')!.value).toBe(1);
      expect(slice.variables.find(variable => variable.name === 'y')!.value).toBe(1);
      for (const point of sweep(slice).branches.flatMap(branch => branch.points)) {
        expect(point.values.a).toBe(values.a); expect(point.values.b).toBe(values.b); expect(point.values.c).toBe(values.c);
        expect(point.values.y).toBeCloseTo(values.a * point.parameter + values.b + values.c);
        expect(point.x).toBeCloseTo(point.parameter + .5);
      }
    }
    expect(config).toEqual(original);
    expect(() => plan.indicesAt(-1)).toThrow(); expect(() => plan.indicesAt(27)).toThrow();
    expect(() => plan.indexOf([1, 1])).toThrow(); expect(() => plan.indexOf([1, 1, 3])).toThrow();
  });

  it('visits centered Manhattan shells exactly once in a deterministic lower-then-higher order', () => {
    const plan = multiSweepPlan(configuration()), order = Array.from(plan.order);
    expect(order).toHaveLength(27); expect(new Set(order).size).toBe(27);
    expect(order.slice(0, 7).map(plan.indicesAt)).toEqual([
      [1, 1, 1], [0, 1, 1], [2, 1, 1], [1, 0, 1], [1, 2, 1], [1, 1, 0], [1, 1, 2],
    ]);
    const distances = order.map(index => plan.indicesAt(index).reduce((sum, value, dimension) => sum + Math.abs(value - plan.startIndices[dimension]), 0));
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    expect(Array.from(plan.order)).toEqual(order);
    expect(Array.isArray(plan.order)).toBe(false);
  });

  it('checks the combined sample limit across every dimension without rounding or dropping samples', () => {
    const config = configuration();
    // 10 main points × 10 × 10 × 250 = exactly 250,000 positions.
    Object.assign(config.variables.find(variable => variable.name === 'x')!, { value: 0, min: 0, max: 9 });
    for (const name of ['a', 'b']) Object.assign(config.variables.find(variable => variable.name === name)!, { value: 0, min: 0, max: 9 });
    Object.assign(config.variables.find(variable => variable.name === 'c')!, { value: 0, min: 0, max: 249 });
    const plan = multiSweepPlan(normalizeSweep(config));
    expect(plan.mainPoints).toBe(10); expect(plan.totalSlices).toBe(25_000);
    const iterator = plan.order[Symbol.iterator]();
    expect(iterator.next().value).toBe(0); // No full Cartesian list is allocated.
    config.variables.find(variable => variable.name === 'c')!.max = 250;
    expect(() => multiSweepPlan(normalizeSweep(config))).toThrow('250,000');
  });

  it('rejects duplicate, missing, unknown, main, and released additional parameters', () => {
    for (const name of ['a', 'missing', 'y', 'x']) {
      const config = configuration(); config.sweep.additional![1].parameter = name;
      expect(() => multiSweepPlan(config)).toThrow('distinct fixed parameters');
    }
    const config = configuration(); Object.assign(config.sweep, { mode: 'constrained', parameter: 'y', release: 'c' });
    expect(() => multiSweepPlan(config)).toThrow('released parameter');
  });

  it('reserves all selectors and the combination frontier within the 1,000 MiB budget', () => {
    const config = configuration(), plan = multiSweepPlan(config), budget = new DoubleSweepBudget(config);
    expect(DEFAULT_DOUBLE_SWEEP_BYTES).toBe(1000 * 1024 * 1024);
    expect(budget.bytes).toBeGreaterThan(192 * plan.totalSlices + 64 * 12);
    expect(() => new DoubleSweepBudget(config, 192 * plan.totalSlices)).toThrow(DoubleSweepMemoryError);
    budget.startSlice(); budget.observe(sweep(configForCombination(config, plan.valuesAt(plan.startIndex))));
    const afterOneSlice = budget.bytes;
    budget.startSlice(); budget.observe(sweep(configForCombination(config, plan.valuesAt(0))));
    expect(budget.bytes).toBeGreaterThan(afterOneSlice);
    const bounded = new DoubleSweepBudget(config, budget.bytes - 1);
    bounded.startSlice(); bounded.observe(sweep(configForCombination(config, plan.valuesAt(plan.startIndex))));
    expect(() => { bounded.startSlice(); bounded.observe(sweep(configForCombination(config, plan.valuesAt(0)))); }).toThrow(DoubleSweepMemoryError);
  });
});

describe('multiple additional sweep worker', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function worker(acknowledge = true) {
    vi.resetModules();
    const solver = await import('./solver'), original = solver.sweepSteps;
    vi.spyOn(solver, 'sweepSteps').mockImplementation((config, _interval, observe) => original(config, 0, observe));
    const messages: WorkerResponse[] = [];
    const host: { postMessage(message: WorkerResponse): void; onmessage?: (event: MessageEvent<WorkerRequest>) => void } = {
      postMessage(message) {
        messages.push(message);
        if (acknowledge && (message.type === 'slice-progress' || message.type === 'slice-complete' || message.type === 'slice-error')) {
          setTimeout(() => host.onmessage!({ data: { type: 'ack', id: message.id } } as MessageEvent<WorkerRequest>), 0);
        }
      },
    };
    vi.stubGlobal('self', host); vi.useFakeTimers(); await import('./worker');
    return { messages, send: (message: WorkerRequest) => host.onmessage!({ data: message } as MessageEvent<WorkerRequest>) };
  }

  it('streams all 27 analytic combinations with independent flat indices and unchanged results', async () => {
    const config = configuration(), plan = multiSweepPlan(config), { messages, send } = await worker();
    send({ type: 'run', id: 101, config }); await vi.runAllTimersAsync();
    expect(messages.at(-1)).toMatchObject({ type: 'double-complete', id: 101, totalSlices: 27 });
    const completed = messages.filter((message): message is Extract<WorkerResponse, { type: 'slice-progress' | 'slice-complete' }> => message.type === 'slice-complete');
    expect(completed.map(message => message.sliceIndex)).toEqual(Array.from(plan.order));
    const results = new Map<number, SweepResult>();
    for (const message of messages) if (message.type === 'slice-complete' || message.type === 'slice-progress') {
      results.set(message.sliceIndex, mergeSweepUpdate(results.get(message.sliceIndex) ?? null, message.update));
      expect(message.value).toBe(plan.valuesAt(message.sliceIndex).a);
    }
    expect(results.size).toBe(27);
    for (const [index, result] of results) {
      const expected = sweep(configForCombination(config, plan.valuesAt(index)));
      expect({ ...result, elapsed: 0 }).toEqual({ ...expected, elapsed: 0 });
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains each failed combination and continues computing the other levels', async () => {
    const config = configuration(); config.equations = 'y^2 = a;';
    Object.assign(config.variables.find(variable => variable.name === 'a')!, { value: 0, min: -1, max: 1 });
    const normalized = normalizeSweep(config), plan = multiSweepPlan(normalized), { messages, send } = await worker();
    send({ type: 'run', id: 102, config: normalized }); await vi.runAllTimersAsync();
    const errors = messages.filter(message => message.type === 'slice-error');
    expect(errors).toHaveLength(9);
    expect(errors.every(message => plan.valuesAt(message.sliceIndex).a === -1)).toBe(true);
    expect(messages.filter(message => message.type === 'slice-complete')).toHaveLength(18);
    expect(messages.at(-1)).toMatchObject({ type: 'double-complete', totalSlices: 27 });
  });

  it('keeps ACK backpressure and releases a replaced multi-parameter run', async () => {
    const config = configuration(), { messages, send } = await worker(false);
    send({ type: 'run', id: 103, config }); await vi.runAllTimersAsync();
    expect(messages.map(message => message.type)).toEqual(['slice-progress']);
    send({ type: 'ack', id: 103 }); await vi.runAllTimersAsync();
    expect(messages.filter(message => message.type === 'slice-complete')).toHaveLength(1);
    send({ type: 'run', id: 104, config }); await vi.runAllTimersAsync();
    for (let attempt = 0; attempt < 100 && messages.at(-1)?.type !== 'double-complete'; attempt++) {
      send({ type: 'ack', id: 104 }); await vi.runAllTimersAsync();
    }
    expect(messages.some(message => message.id === 103 && message.type === 'double-complete')).toBe(false);
    expect(messages.at(-1)).toMatchObject({ type: 'double-complete', id: 104, totalSlices: 27 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops the whole grid on a memory error before posting oversized sample data', async () => {
    const { messages, send } = await worker(), memory = await import('./doubleSweep');
    vi.spyOn(memory.DoubleSweepBudget.prototype, 'observeSample').mockImplementation(() => { throw new memory.DoubleSweepMemoryError(); });
    send({ type: 'run', id: 105, config: configuration() }); await vi.runAllTimersAsync();
    expect(messages).toEqual([{ type: 'error', id: 105, error: expect.stringContaining('memory budget') }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
