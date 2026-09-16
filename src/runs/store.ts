import { DatabaseSync, type SQLOutputValue, type StatementSync } from "node:sqlite";
import type { ProviderName, RunResult } from "../providers/index.js";

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export const RUN_STATUSES: readonly RunStatus[] = ["queued", "running", "succeeded", "failed", "cancelled"];

export function isRunStatus(v: unknown): v is RunStatus {
  return typeof v === "string" && (RUN_STATUSES as readonly string[]).includes(v);
}

export type LogStream = "stdout" | "stderr" | "proxy";

/** A run as the API reports it. Absent optionals are `null`, never omitted. */
export type RunRecord = {
  id: string;
  provider: ProviderName;
  status: RunStatus;
  prompt: string;
  model: string | null;
  systemPrompt: string | null;
  sessionId: string | null;
  zipName: string | null;
  workdir: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  error: string | null;
  result: Omit<RunResult, "provider"> | null;
};

export type LogLine = { id: number; ts: string; stream: LogStream; line: string };

export type NewRun = {
  id: string;
  provider: ProviderName;
  prompt: string;
  model?: string;
  systemPrompt?: string;
  sessionId?: string;
  zipName?: string;
  workdir: string;
};

export type FinishRun = {
  status: Extract<RunStatus, "succeeded" | "failed" | "cancelled">;
  exitCode: number | null;
  error?: string;
  result?: Omit<RunResult, "provider">;
};

type Row = Record<string, SQLOutputValue>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  status        TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  model         TEXT,
  system_prompt TEXT,
  session_id    TEXT,
  zip_name      TEXT,
  workdir       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT,
  exit_code     INTEGER,
  error         TEXT,
  result_json   TEXT
);
CREATE INDEX IF NOT EXISTS runs_status_created ON runs (status, created_at);

CREATE TABLE IF NOT EXISTS run_logs (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  ts     TEXT NOT NULL,
  stream TEXT NOT NULL,
  line   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_logs_run ON run_logs (run_id, id);
`;

function now(): string {
  return new Date().toISOString();
}

const SQLITE_BUSY = 5;

function retryWhileBusy(fn: () => void, attempts = 100, waitMs = 20): void {
  for (let i = 1; ; i++) {
    try {
      fn();
      return;
    } catch (err) {
      const busy =
        typeof err === "object" && err !== null && (err as { errcode?: number }).errcode === SQLITE_BUSY;
      if (!busy || i >= attempts) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
}

function toRecord(row: Row): RunRecord {
  const s = (k: string): string | null => (typeof row[k] === "string" ? (row[k] as string) : null);
  const resultJson = s("result_json");
  return {
    id: row["id"] as string,
    provider: row["provider"] as ProviderName,
    status: row["status"] as RunStatus,
    prompt: row["prompt"] as string,
    model: s("model"),
    systemPrompt: s("system_prompt"),
    sessionId: s("session_id"),
    zipName: s("zip_name"),
    workdir: row["workdir"] as string,
    createdAt: row["created_at"] as string,
    startedAt: s("started_at"),
    finishedAt: s("finished_at"),
    exitCode: typeof row["exit_code"] === "number" ? row["exit_code"] : null,
    error: s("error"),
    result: resultJson ? (JSON.parse(resultJson) as Omit<RunResult, "provider">) : null,
  };
}

export class RunStore {
  private readonly db: DatabaseSync;
  private readonly insertRun: StatementSync;
  private readonly selectRun: StatementSync;
  private readonly insertLog: StatementSync;
  private readonly selectLogs: StatementSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    // Switching to WAL needs an exclusive lock and SQLite does not run the
    // busy handler for it, so two processes opening at once (two proxies on
    // one file, or parallel test workers) must retry by hand.
    retryWhileBusy(() => this.db.exec("PRAGMA journal_mode = WAL;"));
    // `appendLog` commits once per output line, on the event loop thread. The
    // default FULL would fsync the WAL every time and stall the HTTP server
    // whenever a run is chatty; NORMAL is durable enough here, since a run
    // interrupted by a crash is failed on restart anyway.
    this.db.exec("PRAGMA synchronous = NORMAL;");
    retryWhileBusy(() => this.db.exec(SCHEMA));

    this.insertRun = this.db.prepare(
      `INSERT INTO runs (id, provider, status, prompt, model, system_prompt, session_id, zip_name, workdir, created_at)
       VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.selectRun = this.db.prepare("SELECT * FROM runs WHERE id = ?");
    this.insertLog = this.db.prepare(
      "INSERT INTO run_logs (run_id, ts, stream, line) SELECT id, ?, ?, ? FROM runs WHERE id = ?",
    );
    this.selectLogs = this.db.prepare(
      "SELECT id, ts, stream, line FROM run_logs WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?",
    );
  }

  create(input: NewRun): RunRecord {
    this.insertRun.run(
      input.id,
      input.provider,
      input.prompt,
      input.model ?? null,
      input.systemPrompt ?? null,
      input.sessionId ?? null,
      input.zipName ?? null,
      input.workdir,
      now(),
    );
    return this.get(input.id)!;
  }

  get(id: string): RunRecord | undefined {
    const row = this.selectRun.get(id) as Row | undefined;
    return row ? toRecord(row) : undefined;
  }

  list(opts: { status?: RunStatus; limit: number }): RunRecord[] {
    const rows = opts.status
      ? this.db
          .prepare("SELECT * FROM runs WHERE status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
          .all(opts.status, opts.limit)
      : this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC, rowid DESC LIMIT ?").all(opts.limit);
    return (rows as Row[]).map(toRecord);
  }

  /** Moves a queued run to running. Returns false if it was no longer queued. */
  markRunning(id: string): boolean {
    const res = this.db
      .prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'")
      .run(now(), id);
    return res.changes === 1;
  }

  finish(id: string, outcome: FinishRun): void {
    this.db
      .prepare(
        `UPDATE runs SET status = ?, finished_at = ?, exit_code = ?, error = ?, result_json = ?
         WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .run(
        outcome.status,
        now(),
        outcome.exitCode,
        outcome.error ?? null,
        outcome.result ? JSON.stringify(outcome.result) : null,
        id,
      );
  }

  /** No-op when the run has been deleted, so a late log line cannot fail. */
  appendLog(id: string, stream: LogStream, line: string): void {
    this.insertLog.run(now(), stream, line, id);
  }

  logs(id: string, opts: { after: number; limit: number }): LogLine[] {
    return this.selectLogs.all(id, opts.after, opts.limit) as unknown as LogLine[];
  }

  /** Removes the run and its logs. Returns false if it did not exist. */
  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM runs WHERE id = ?").run(id).changes === 1;
  }

  /**
   * Fails runs left queued or running by a previous process. Call once at
   * startup, before the runner starts accepting work.
   */
  recoverOrphans(): number {
    const ts = now();
    const orphans = this.db
      .prepare("SELECT id FROM runs WHERE status IN ('queued', 'running')")
      .all() as Row[];
    for (const row of orphans) {
      this.appendLog(row["id"] as string, "proxy", "proxy restarted while this run was in progress");
    }
    return this.db
      .prepare(
        `UPDATE runs SET status = 'failed', finished_at = ?, error = 'proxy restarted while the run was in progress'
         WHERE status IN ('queued', 'running')`,
      )
      .run(ts).changes as number;
  }

  close(): void {
    this.db.close();
  }
}
