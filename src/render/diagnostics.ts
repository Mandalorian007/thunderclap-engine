/**
 * GPU error reporting. Every WGSL compile error and uncaptured validation error goes through
 * `reportGpuError`, which logs loudly and keeps the last messages for tests/debug overlays.
 */

const MAX_KEPT = 50;

export const gpuDiagnostics = {
  /** Most recent error messages (bounded). */
  errors: [] as string[],
  /** Total errors reported since load. */
  errorCount: 0,
};

const listeners = new Set<(message: string) => void>();

export function reportGpuError(message: string): void {
  console.error(message);
  gpuDiagnostics.errorCount++;
  gpuDiagnostics.errors.push(message);
  if (gpuDiagnostics.errors.length > MAX_KEPT) gpuDiagnostics.errors.shift();
  for (const fn of listeners) fn(message);
}

/** Subscribe to GPU errors (e.g. to show a dev toast). Returns unsubscribe. */
export function onGpuError(fn: (message: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const logged = new WeakSet<GPUDevice>();

/** Route uncaptured device errors (validation, OOM, internal) to `reportGpuError`. */
export function installGpuErrorLogging(device: GPUDevice): void {
  // Several renderers may share a device (e.g. a SnapshotRenderer); log each error once.
  if (logged.has(device)) return;
  logged.add(device);
  device.addEventListener('uncapturederror', (ev) => {
    const e = (ev as GPUUncapturedErrorEvent).error;
    const kind =
      e instanceof GPUValidationError
        ? 'validation'
        : e instanceof GPUOutOfMemoryError
          ? 'out-of-memory'
          : 'internal';
    reportGpuError(`[gpu] uncaptured ${kind} error: ${e.message}`);
  });
}
