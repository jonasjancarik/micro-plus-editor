import type { RepeatingTimer } from '../core/amp';

const WORKER = 'onmessage = ({ data }) => setInterval(() => postMessage(0), data);';

/**
 * Browsers slow a hidden page's timers to once a second, which is too slow for the amp's keep-alive.
 * A worker's timers keep their pace, so the worker does the counting.
 */
export const steadyTimer: RepeatingTimer = (callback, ms) => {
  const url = URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' }));
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  worker.onmessage = callback;
  worker.postMessage(ms);
  return () => worker.terminate();
};
