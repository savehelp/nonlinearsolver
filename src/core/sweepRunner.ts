import type { Configuration, SweepResult } from './types';
import { mergeSweepUpdate, type WorkerRequest, type WorkerResponse } from './sweepStream';
import { prepareSweepReuse, type SweepReuse } from './sampleReuse';

export interface SweepWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: WorkerRequest): void;
  terminate(): void;
}
export type SweepEvent = { type: 'pending' }
  | { type: 'result'; config: Configuration; result: SweepResult; completed: number; complete: boolean }
  | { type: 'slice'; config: Configuration; result: SweepResult; completed: number; complete: boolean; index: number; value: number }
  | { type: 'slice-error'; config: Configuration; index: number; value: number; error: string }
  | { type: 'double-complete'; config: Configuration; totalSlices: number; elapsed: number }
  | { type: 'error'; config: Configuration; error: string };

/** Owns one active solve. Explicit double-sweep slices are retained by the UI;
 * ordinary sweeps always run again, and queued messages cannot replace a newer run. */
export class SweepRunner {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private worker: SweepWorker | undefined;

  constructor(private createWorker: () => SweepWorker, private publish: (event: SweepEvent) => void) {}

  cancel(): void {
    this.generation++;
    clearTimeout(this.timer); this.timer = undefined;
    this.releaseWorker();
  }

  run(config: Configuration, delay = 220, reuse?: SweepReuse): void {
    this.cancel();
    const id = this.generation;
    this.publish({ type: 'pending' });
    this.timer = setTimeout(() => {
      this.timer = undefined;
      let accumulated: SweepResult | null = null;
      let currentSlice = -1;
      let settled = false;
      const fail = (error: string) => {
        if (id !== this.generation || settled) return;
        settled = true;
        this.releaseWorker();
        this.publish({ type: 'error', config, error });
      };
      try {
        const worker = this.createWorker(); this.worker = worker;
        worker.onmessage = ({ data }) => {
          if (id !== this.generation || data.id !== id || settled) return;
          if (data.type === 'error') { fail(data.error); return; }
          if (data.type === 'double-complete') {
            settled = true; accumulated = null; this.releaseWorker();
            this.publish({ type: 'double-complete', config, totalSlices: data.totalSlices, elapsed: data.elapsed });
            return;
          }
          if (data.type === 'slice-error') {
            accumulated = null; currentSlice = -1;
            this.publish({ type: 'slice-error', config, index: data.sliceIndex, value: data.value, error: data.error });
            if (id === this.generation) worker.postMessage({ type: 'ack', id });
            return;
          }
          if (data.type === 'slice-progress' || data.type === 'slice-complete') {
            if (currentSlice !== data.sliceIndex) { accumulated = null; currentSlice = data.sliceIndex; }
            accumulated = mergeSweepUpdate(accumulated, data.update);
            const complete = data.type === 'slice-complete';
            this.publish({ type: 'slice', config, result: accumulated, completed: data.update.completed, complete, index: data.sliceIndex, value: data.value });
            if (complete) { accumulated = null; currentSlice = -1; }
            if (id === this.generation) worker.postMessage({ type: 'ack', id });
            return;
          }
          accumulated = mergeSweepUpdate(accumulated, data.update);
          const complete = data.type === 'complete';
          if (complete) { settled = true; this.releaseWorker(); }
          this.publish({ type: 'result', config, result: accumulated, completed: data.update.completed, complete });
          if (!complete && id === this.generation) worker.postMessage({ type: 'ack', id });
        };
        worker.onerror = event => fail(event.message || 'The calculation worker failed.');
        const samples = reuse && prepareSweepReuse(config, reuse);
        worker.postMessage({ type: 'run', id, config, ...(samples ? { reuse: samples } : {}) });
      } catch (error) { fail(error instanceof Error ? error.message : 'The calculation worker failed.'); }
    }, delay);
  }

  private releaseWorker(): void {
    if (!this.worker) return;
    this.worker.onmessage = null; this.worker.onerror = null;
    this.worker.terminate(); this.worker = undefined;
  }
}
