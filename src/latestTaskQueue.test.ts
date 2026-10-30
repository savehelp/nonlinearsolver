import { describe, expect, it, vi } from 'vitest';
import { LatestTaskQueue } from './latestTaskQueue';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('latest plot task queue', () => {
  it('keeps one active render and replaces intermediate pending frames with the latest', async () => {
    const first = deferred(), last = deferred(), idle = vi.fn();
    const render = vi.fn((frame: number) => frame === 1 ? first.promise : last.promise);
    const queue = new LatestTaskQueue(render, idle);
    queue.submit(1); queue.submit(2); queue.submit(3); queue.submit(4);
    expect(render.mock.calls).toEqual([[1]]); expect(queue.busy).toBe(true);
    first.resolve(); await vi.waitFor(() => expect(render.mock.calls).toEqual([[1], [4]]));
    expect(idle).not.toHaveBeenCalled();
    last.resolve(); await vi.waitFor(() => expect(idle).toHaveBeenCalledOnce());
    expect(queue.busy).toBe(false);
  });

  it('drops pending work on unmount and shares the active lane across a StrictMode remount', async () => {
    const first = deferred(), render = vi.fn((frame: number) => frame === 1 ? first.promise : Promise.resolve());
    const queue = new LatestTaskQueue(render);
    queue.submit(1); queue.submit(2); queue.clear(); queue.submit(3);
    expect(render.mock.calls).toEqual([[1]]);
    first.resolve(); await vi.waitFor(() => expect(render.mock.calls).toEqual([[1], [3]]));
    expect(queue.busy).toBe(false);
  });

  it('finishes cleanup after an active render and recovers from a rejected render', async () => {
    const first = deferred(), idle = vi.fn(), errors = vi.fn();
    const queue = new LatestTaskQueue(() => first.promise, idle, errors);
    queue.submit(1); queue.submit(2); queue.clear();
    expect(idle).not.toHaveBeenCalled(); first.resolve();
    await vi.waitFor(() => expect(idle).toHaveBeenCalledOnce());
    expect(queue.busy).toBe(false);
    const recovering = new LatestTaskQueue(async (frame: number) => { if (frame === 1) throw new Error('render failed'); }, idle, errors);
    recovering.submit(1); recovering.submit(2);
    await vi.waitFor(() => expect(recovering.busy).toBe(false));
    expect(errors).toHaveBeenCalledOnce(); expect(idle).toHaveBeenCalledTimes(2);
  });
});
