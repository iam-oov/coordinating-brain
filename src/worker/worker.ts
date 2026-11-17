import { claimNextApproved } from '../store.ts';
import type { PipelineDeps } from './pipeline.ts';
import { processRequest } from './pipeline.ts';

export interface WorkerHandle {
  /** Check the queue now instead of waiting for the next poll. */
  wake(): void;
  /** Finish the current request and stop. */
  stop(): Promise<void>;
}

/** Processes approved requests one at a time. */
export function startWorker(deps: PipelineDeps, pollMs: number, onError: (e: unknown) => void = console.error): WorkerHandle {
  let stopped = false;
  let wakeUp: (() => void) | null = null;

  const sleep = () =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, pollMs);
      wakeUp = () => {
        clearTimeout(t);
        resolve();
      };
    });

  const loop = (async () => {
    while (!stopped) {
      try {
        const req = claimNextApproved(deps.db);
        if (req) {
          await processRequest(deps, req);
          continue;
        }
      } catch (e) {
        onError(e);
      }
      await sleep();
    }
  })();

  return {
    wake: () => wakeUp?.(),
    stop: async () => {
      stopped = true;
      wakeUp?.();
      await loop;
    },
  };
}
