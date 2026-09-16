import { execProvider, ProviderError, type RunRequest } from "../providers/index.js";
import type { RunRecord, RunStore } from "./store.js";

export type RunnerOptions = {
  maxConcurrent: number;
  timeoutMs: number;
};

type Pending = {
  /** Merged over the proxy's environment for this run only; never persisted. */
  env: Record<string, string>;
};

type Active = {
  controller: AbortController;
  done: Promise<void>;
};

/**
 * Executes queued runs in the background, at most `maxConcurrent` at a time,
 * streaming every output line into the store as it happens.
 */
export class Runner {
  private readonly queue: string[] = [];
  private readonly pending = new Map<string, Pending>();
  private readonly active = new Map<string, Active>();

  constructor(
    private readonly store: RunStore,
    private readonly opts: RunnerOptions,
  ) {}

  enqueue(id: string, env: Record<string, string> = {}): void {
    this.pending.set(id, { env });
    this.queue.push(id);
    this.store.appendLog(id, "proxy", `queued (${this.active.size} running, ${this.queue.length - 1} ahead)`);
    this.pump();
  }

  /**
   * Cancels a queued or running run. Resolves once the run has fully
   * stopped and its final state is stored; resolves false if nothing was
   * in flight for that id.
   */
  async cancel(id: string): Promise<boolean> {
    const queued = this.queue.indexOf(id);
    if (queued !== -1) {
      this.queue.splice(queued, 1);
      this.pending.delete(id);
      this.store.appendLog(id, "proxy", "cancelled while queued");
      this.store.finish(id, { status: "cancelled", exitCode: null, error: "cancelled while queued" });
      return true;
    }
    const active = this.active.get(id);
    if (!active) return false;
    active.controller.abort();
    await active.done;
    return true;
  }

  isActive(id: string): boolean {
    return this.active.has(id) || this.pending.has(id);
  }

  /** Kills everything in flight. Runs are marked cancelled. */
  async shutdown(): Promise<void> {
    const ids = [...this.queue, ...this.active.keys()];
    await Promise.all(ids.map((id) => this.cancel(id)));
  }

  private pump(): void {
    while (this.active.size < this.opts.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const pending = this.pending.get(id);
      this.pending.delete(id);
      const controller = new AbortController();
      const done = this.execute(id, pending?.env ?? {}, controller.signal)
        // Nothing awaits this on the happy path, so a throw from the store
        // (disk full, busy timeout, closed mid-shutdown) would otherwise be an
        // unhandled rejection and take the whole proxy down with it.
        .catch((err: unknown) => console.error(`run ${id} could not be recorded:`, err))
        .finally(() => {
          this.active.delete(id);
          this.pump();
        });
      this.active.set(id, { controller, done });
    }
  }

  private async execute(id: string, env: Record<string, string>, signal: AbortSignal): Promise<void> {
    const run = this.store.get(id);
    if (!run || !this.store.markRunning(id)) return;

    const log = (line: string) => this.store.appendLog(id, "proxy", line);
    log(`starting ${run.provider} in ${run.workdir}`);

    try {
      const result = await execProvider(run.provider, toRequest(run), {
        cwd: run.workdir,
        env: { ...process.env, ...env },
        timeoutMs: this.opts.timeoutMs,
        signal,
        onLine: (stream, line) => this.store.appendLog(id, stream, line),
      });
      log(`${run.provider} finished`);
      this.store.finish(id, { status: "succeeded", exitCode: 0, result });
    } catch (err) {
      if (err instanceof ProviderError) {
        log(err.message);
        this.store.finish(id, {
          status: signal.aborted ? "cancelled" : "failed",
          exitCode: err.code,
          error: err.message,
        });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        log(`internal error: ${message}`);
        this.store.finish(id, { status: "failed", exitCode: null, error: message });
      }
    }
  }
}

function toRequest(run: RunRecord): RunRequest {
  const req: RunRequest = { prompt: run.prompt };
  if (run.sessionId) req.sessionId = run.sessionId;
  if (run.model) req.model = run.model;
  if (run.systemPrompt) req.systemPrompt = run.systemPrompt;
  return req;
}
