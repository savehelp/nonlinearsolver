import { prepare, sweepSteps } from './solver';
import { createSweepUpdates, type WorkerRequest, type WorkerResponse } from './sweepStream';
import { configForCombination, DoubleSweepBudget, DoubleSweepMemoryError, multiSweepPlan, SweepBudget } from './doubleSweep';
import { sliceSweeps } from './variables';

interface Context { id: number; inFlight: boolean; acknowledge?: () => void }
let active: Context | null = null;
const send = (message: WorkerResponse) => self.postMessage(message);
const yieldToMessages = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const waitForAck = (context: Context) => context.inFlight
  ? new Promise<void>(resolve => { context.acknowledge = resolve; }) : Promise.resolve();

function tracked(context: Context, message: WorkerResponse): void {
  context.inFlight = true;
  send(message);
}

async function doubleSweep(message: Extract<WorkerRequest, { type: 'run' }>, context: Context) {
  const start = performance.now(), plan = multiSweepPlan(message.config), budget = new DoubleSweepBudget(message.config);
  // Reject shared configuration problems once before attempting every slice.
  prepare(configForCombination(message.config, plan.valuesAt(plan.startIndex)), message.config.sweep.startAt ?? message.config.sweep.min);
  for (const sliceIndex of plan.order) {
    if (active !== context) return;
    const values = plan.valuesAt(sliceIndex), value = values[plan.dimensions[0].parameter], update = createSweepUpdates();
    budget.startSlice();
    try {
      const steps = sweepSteps(configForCombination(message.config, values), 200, (_result, sample) => budget.observeSample(sample));
      let step = steps.next();
      while (!step.done) {
        if (active !== context) return;
        if (!context.inFlight) tracked(context, { type: 'slice-progress', id: context.id, sliceIndex, value, update: update(step.value.result, step.value.completed) });
        await yieldToMessages();
        if (active !== context) return;
        step = steps.next();
      }
      budget.observe(step.value.result);
      await waitForAck(context);
      if (active !== context) return;
      tracked(context, { type: 'slice-complete', id: context.id, sliceIndex, value, update: update(step.value.result, step.value.completed) });
    } catch (error) {
      if (error instanceof DoubleSweepMemoryError) throw error;
      const reason = error instanceof Error ? error.message : 'Calculation failed.';
      budget.recordError(reason);
      await waitForAck(context);
      if (active !== context) return;
      tracked(context, { type: 'slice-error', id: context.id, sliceIndex, value, error: reason });
    }
    // Do not queue complete slices faster than the main thread can retain them.
    await waitForAck(context);
    if (active !== context) return;
  }
  if (active === context) {
    send({ type: 'double-complete', id: context.id, elapsed: performance.now() - start, totalSlices: plan.totalSlices });
    active = null;
  }
}

async function run(message: Extract<WorkerRequest, { type: 'run' }>) {
  active?.acknowledge?.();
  const context: Context = { id: message.id, inFlight: false };
  active = context;
  const update = createSweepUpdates();
  try {
    if (sliceSweeps(message.config).length) { await doubleSweep(message, context); return; }
    const budget = new SweepBudget(message.config); budget.startSlice();
    const steps = sweepSteps(message.config, 200, (_result, sample) => budget.observeSample(sample));
    let step = steps.next();
    while (!step.done) {
      if (active !== context) return;
      if (!context.inFlight) {
        tracked(context, { type: 'progress', id: context.id, update: update(step.value.result, step.value.completed) });
      }
      // Let acknowledgements arrive without adding a task for every sample.
      await yieldToMessages();
      if (active !== context) return;
      step = steps.next();
    }
    if (active === context) {
      budget.observe(step.value.result);
      // One pending progress plus this final delta is the maximum message queue.
      send({ type: 'complete', id: context.id, update: update(step.value.result, step.value.completed) });
      active = null;
    }
  } catch (error) {
    if (active === context) {
      send({ type: 'error', id: context.id, error: error instanceof Error ? error.message : 'Calculation failed.' });
      active = null;
    }
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === 'ack') {
    if (active?.id === message.id) {
      active.inFlight = false;
      const acknowledge = active.acknowledge; active.acknowledge = undefined; acknowledge?.();
    }
  } else {
    void run(message);
  }
};
