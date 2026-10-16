// Structured run logging: human line on stdout + JSONL file + (optional) Neon app_log.
// Usage: const log = createLogger('db-load-full'); log.info('batch done', {n}); await log.close();
import { appendFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export type Level = 'info' | 'warn' | 'error';
export interface Logger {
  runId: string;
  stage: string;
  info: (msg: string, details?: Record<string, unknown>) => void;
  warn: (msg: string, details?: Record<string, unknown>) => void;
  error: (msg: string, details?: Record<string, unknown>) => void;
  close: () => Promise<void>;
}

let dbPool: { query: (t: string, v?: unknown[]) => Promise<unknown> } | null = null;
let dbWarned = false;

export function createLogger(stage: string): Logger {
  const runId = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(4).toString('hex')}`;
  mkdirSync('logs', { recursive: true });
  const file = `logs/${stage}-${runId}.log`;
  const buf: string[] = [];
  let closed = false;

  async function flushToDb() {
    if (!dbPool || buf.length === 0) return;
    const lines = buf.splice(0, buf.length);
    try {
      for (const line of lines) {
        const e = JSON.parse(line);
        await dbPool.query(
          `insert into app_log (run_id, stage, level, message, details) values ($1,$2,$3,$4,$5)`,
          [e.runId, e.stage, e.level, e.message, e.details ? JSON.stringify(e.details) : null]
        );
      }
    } catch {
      if (!dbWarned) { console.error(`[log] db sink unavailable, file only`); dbWarned = true; }
      // re-queue on failure? No — file already has them. Drop to avoid dupes.
    }
  }

  function emit(level: Level, message: string, details?: Record<string, unknown>) {
    const entry = { ts: new Date().toISOString(), runId, stage, level, message, details };
    const line = JSON.stringify(entry);
    appendFileSync(file, line + '\n');
    buf.push(line);
    const d = details ? ' ' + JSON.stringify(details) : '';
    if (level === 'error') console.error(`[${runId}] ERROR ${message}${d}`);
    else console.log(`[${runId}] ${message}${d}`);
    if (buf.length >= 50) void flushToDb();
  }

  return {
    runId,
    stage,
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
    close: async () => {
      if (closed) return;
      closed = true;
      await flushToDb();
    },
  };
}

/** Attach a pg Pool as the DB sink for app_log. Call once at startup. */
export function attachDbSink(pool: { query: (t: string, v?: unknown[]) => Promise<unknown> }) {
  dbPool = pool;
}
