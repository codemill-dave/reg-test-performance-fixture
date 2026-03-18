# Playwright Performance Fixture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Playwright fixture that auto-captures HTTP performance metrics for every regression test and writes them to a Postgres timeseries database.

**Architecture:** A single auto-use Playwright fixture (`perfFixture`) intercepts all HTTP responses via `page.on('response')`, buffers records per-test, and flushes to Postgres through a shared async queue at teardown. Configuration is resolved from env vars with fallback to `perf.config.json`.

**Tech Stack:** TypeScript, `@playwright/test`, `pg` (node-postgres), `vitest` (unit tests)

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `playwright.config.ts`
- Create: `perf.config.json`
- Create: `.gitignore`

**Step 1: Create `package.json`**

```json
{
  "name": "reg-test-performance-fixture",
  "version": "1.0.0",
  "description": "Playwright fixture for capturing HTTP performance metrics to Postgres",
  "scripts": {
    "test:unit": "vitest run",
    "test:e2e": "playwright test",
    "test": "npm run test:unit && npm run test:e2e",
    "db:init": "ts-node src/schema.ts"
  },
  "dependencies": {
    "pg": "^8.13.3"
  },
  "devDependencies": {
    "@playwright/test": "^1.51.0",
    "@types/node": "^22.13.10",
    "@types/pg": "^8.11.11",
    "ts-node": "^10.9.2",
    "typescript": "^5.8.2",
    "vitest": "^3.0.8"
  }
}
```

**Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": ".",
    "skipLibCheck": true
  },
  "include": ["src/**/*", "tests/**/*", "playwright.config.ts"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 3: Create `playwright.config.ts`**

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  use: {
    headless: true,
  },
  globalTeardown: './src/globalTeardown.ts',
});
```

**Step 4: Create `perf.config.json`**

```json
{
  "environment": "local",
  "version": "unknown",
  "database": {
    "host": "localhost",
    "port": 5432,
    "user": "perf",
    "password": "perf",
    "dbName": "perf_metrics"
  }
}
```

**Step 5: Create `.gitignore`**

```
node_modules/
dist/
playwright-report/
test-results/
```

**Step 6: Install dependencies**

```bash
npm install
npx playwright install chromium
```

Expected: Dependencies installed, `node_modules/` created.

**Step 7: Commit**

```bash
git add package.json tsconfig.json playwright.config.ts perf.config.json .gitignore
git commit -m "chore: scaffold project"
```

---

### Task 2: Database Schema

**Files:**
- Create: `src/schema.ts`
- Create: `db/init.sql`

**Step 1: Create `db/init.sql`**

```sql
CREATE TABLE IF NOT EXISTS performance_measurements (
  id                    BIGSERIAL PRIMARY KEY,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  test_name             TEXT NOT NULL,
  environment           TEXT NOT NULL,
  version               TEXT NOT NULL,
  url                   TEXT NOT NULL,
  method                TEXT NOT NULL,
  status_code           INTEGER NOT NULL,
  response_time_ms      INTEGER NOT NULL,
  response_size_bytes   INTEGER,
  content_type          TEXT,
  assertions            JSONB
);

CREATE INDEX IF NOT EXISTS idx_perf_recorded_at ON performance_measurements (recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_perf_test_name   ON performance_measurements (test_name);
CREATE INDEX IF NOT EXISTS idx_perf_environment  ON performance_measurements (environment);
```

**Step 2: Create `src/schema.ts`**

This script reads `db/init.sql` and executes it — used as a setup step before running tests.

```typescript
import { readFileSync } from 'fs';
import { join } from 'path';
import { getPool } from './db';

async function initSchema(): Promise<void> {
  const sql = readFileSync(join(__dirname, '../db/init.sql'), 'utf-8');
  const pool = getPool();
  try {
    await pool.query(sql);
    console.log('[perf] Schema initialized successfully');
  } finally {
    await pool.end();
  }
}

initSchema().catch((err) => {
  console.error('[perf] Schema initialization failed:', err.message);
  process.exit(1);
});
```

**Step 3: Commit**

```bash
mkdir -p db
git add db/init.sql src/schema.ts
git commit -m "feat: add database schema and init script"
```

---

### Task 3: Database Client (`db.ts`)

**Files:**
- Create: `src/db.ts`
- Create: `src/config.ts`
- Create: `tests/unit/config.test.ts`
- Create: `tests/unit/db.test.ts`

**Step 1: Create `src/config.ts`**

Resolves connection config from env vars → `perf.config.json`.

```typescript
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface PerfConfig {
  environment: string;
  version: string;
  database: {
    connectionString?: string;
    host: string;
    port: number;
    user: string;
    password: string;
    dbName: string;
  };
}

function loadJsonConfig(): Partial<PerfConfig> {
  const configPath = join(process.cwd(), 'perf.config.json');
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

export function resolveConfig(): PerfConfig {
  const json = loadJsonConfig();
  const jsonDb = json.database ?? {};

  return {
    environment: process.env.PERF_ENV ?? json.environment ?? 'local',
    version: process.env.PERF_VERSION ?? json.version ?? 'unknown',
    database: {
      connectionString: process.env.DATABASE_URL,
      host: process.env.PG_HOST ?? jsonDb.host ?? 'localhost',
      port: parseInt(process.env.PG_PORT ?? String(jsonDb.port ?? 5432), 10),
      user: process.env.PG_USER ?? jsonDb.user ?? 'perf',
      password: process.env.PG_PASSWORD ?? jsonDb.password ?? 'perf',
      dbName: process.env.PG_DB ?? jsonDb.dbName ?? 'perf_metrics',
    },
  };
}
```

**Step 2: Write failing test for config**

Create `tests/unit/config.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('resolveConfig', () => {
  beforeEach(() => {
    vi.resetModules();
    // Clear relevant env vars
    delete process.env.PERF_ENV;
    delete process.env.PERF_VERSION;
    delete process.env.DATABASE_URL;
    delete process.env.PG_HOST;
  });

  it('returns defaults when no env vars or config file', async () => {
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return { ...actual, existsSync: () => false };
    });
    const { resolveConfig } = await import('../../src/config');
    const cfg = resolveConfig();
    expect(cfg.environment).toBe('local');
    expect(cfg.version).toBe('unknown');
    expect(cfg.database.host).toBe('localhost');
    expect(cfg.database.port).toBe(5432);
  });

  it('env vars take priority over defaults', async () => {
    process.env.PERF_ENV = 'staging';
    process.env.PERF_VERSION = '2.0.0';
    process.env.PG_HOST = 'db.example.com';
    vi.mock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return { ...actual, existsSync: () => false };
    });
    const { resolveConfig } = await import('../../src/config');
    const cfg = resolveConfig();
    expect(cfg.environment).toBe('staging');
    expect(cfg.version).toBe('2.0.0');
    expect(cfg.database.host).toBe('db.example.com');
  });
});
```

**Step 3: Run test to verify it fails**

```bash
npm run test:unit -- tests/unit/config.test.ts
```

Expected: FAIL — `resolveConfig` not found.

**Step 4: Run test to verify it passes**

After creating `src/config.ts` above:

```bash
npm run test:unit -- tests/unit/config.test.ts
```

Expected: PASS

**Step 5: Create `src/db.ts`**

```typescript
import { Pool } from 'pg';
import { resolveConfig } from './config';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  const cfg = resolveConfig();
  const dbCfg = cfg.database;

  pool = dbCfg.connectionString
    ? new Pool({ connectionString: dbCfg.connectionString })
    : new Pool({
        host: dbCfg.host,
        port: dbCfg.port,
        user: dbCfg.user,
        password: dbCfg.password,
        database: dbCfg.dbName,
      });

  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
```

**Step 6: Commit**

```bash
git add src/config.ts src/db.ts tests/unit/config.test.ts
git commit -m "feat: add config resolution and postgres client"
```

---

### Task 4: Recorder (`recorder.ts`)

**Files:**
- Create: `src/recorder.ts`
- Create: `tests/unit/recorder.test.ts`

**Step 1: Write failing test**

Create `tests/unit/recorder.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createRecorder } from '../../src/recorder';

describe('createRecorder', () => {
  it('returns an empty records array initially', () => {
    const recorder = createRecorder();
    expect(recorder.records).toEqual([]);
  });

  it('onRequest + onResponse pair produces a record', async () => {
    const recorder = createRecorder();

    const fakeRequest = {
      url: () => 'https://example.com/api',
      method: () => 'GET',
    };

    const fakeResponse = {
      request: () => fakeRequest,
      status: () => 200,
      headers: () => ({ 'content-type': 'application/json', 'content-length': '512' }),
    };

    const startTime = Date.now();
    recorder.onRequest(fakeRequest as any, startTime);

    await new Promise((r) => setTimeout(r, 10));

    recorder.onResponse(fakeResponse as any, Date.now());

    expect(recorder.records).toHaveLength(1);
    const rec = recorder.records[0];
    expect(rec.url).toBe('https://example.com/api');
    expect(rec.method).toBe('GET');
    expect(rec.statusCode).toBe(200);
    expect(rec.responseTimeMs).toBeGreaterThanOrEqual(10);
    expect(rec.responseSizeBytes).toBe(512);
    expect(rec.contentType).toBe('application/json');
    expect(rec.assertions).toBeDefined();
  });

  it('ignores responses with no matching request', () => {
    const recorder = createRecorder();
    const fakeResponse = {
      request: () => ({ url: () => 'https://example.com', method: () => 'GET' }),
      status: () => 200,
      headers: () => ({}),
    };
    recorder.onResponse(fakeResponse as any, Date.now());
    expect(recorder.records).toHaveLength(0);
  });
});
```

**Step 2: Run to verify failure**

```bash
npm run test:unit -- tests/unit/recorder.test.ts
```

Expected: FAIL — `createRecorder` not found.

**Step 3: Create `src/recorder.ts`**

```typescript
import type { Request, Response } from '@playwright/test';

export interface PerfRecord {
  url: string;
  method: string;
  statusCode: number;
  responseTimeMs: number;
  responseSizeBytes: number | null;
  contentType: string | null;
  assertions: Record<string, string>;
}

export interface Recorder {
  onRequest(request: Request, startTime: number): void;
  onResponse(response: Response, endTime: number): void;
  records: PerfRecord[];
}

const CAPTURED_HEADERS = ['x-request-id', 'x-trace-id', 'cache-control', 'etag'];

export function createRecorder(): Recorder {
  const records: PerfRecord[] = [];
  const requestTimings = new WeakMap<Request, number>();

  return {
    records,
    onRequest(request: Request, startTime: number): void {
      requestTimings.set(request, startTime);
    },
    onResponse(response: Response, endTime: number): void {
      const request = response.request();
      const startTime = requestTimings.get(request);
      if (startTime === undefined) return;

      const headers = response.headers();
      const contentLength = headers['content-length'];
      const assertions: Record<string, string> = {};
      for (const header of CAPTURED_HEADERS) {
        if (headers[header]) assertions[header] = headers[header];
      }

      records.push({
        url: request.url(),
        method: request.method(),
        statusCode: response.status(),
        responseTimeMs: endTime - startTime,
        responseSizeBytes: contentLength ? parseInt(contentLength, 10) : null,
        contentType: headers['content-type'] ?? null,
        assertions,
      });
    },
  };
}
```

**Step 4: Run to verify pass**

```bash
npm run test:unit -- tests/unit/recorder.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/recorder.ts tests/unit/recorder.test.ts
git commit -m "feat: add HTTP response recorder"
```

---

### Task 5: Write Queue (`queue.ts`)

**Files:**
- Create: `src/queue.ts`
- Create: `tests/unit/queue.test.ts`

**Step 1: Write failing test**

Create `tests/unit/queue.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('queue', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts empty', async () => {
    const { getQueue } = await import('../../src/queue');
    const q = getQueue();
    expect(q.size()).toBe(0);
  });

  it('enqueue increases size', async () => {
    const { getQueue } = await import('../../src/queue');
    const q = getQueue();
    q.enqueue([{
      testName: 'test', environment: 'local', version: '1.0',
      url: 'https://example.com', method: 'GET', statusCode: 200,
      responseTimeMs: 100, responseSizeBytes: null, contentType: null, assertions: {}
    }]);
    expect(q.size()).toBe(1);
  });

  it('flush empties the queue and calls insert', async () => {
    const mockInsert = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../src/db', () => ({ getPool: () => ({ query: mockInsert }) }));
    const { getQueue } = await import('../../src/queue');
    const q = getQueue();
    q.enqueue([{
      testName: 'test', environment: 'local', version: '1.0',
      url: 'https://example.com', method: 'GET', statusCode: 200,
      responseTimeMs: 100, responseSizeBytes: null, contentType: null, assertions: {}
    }]);
    await q.flush();
    expect(q.size()).toBe(0);
    expect(mockInsert).toHaveBeenCalledOnce();
  });

  it('flush warns and continues if DB is unavailable', async () => {
    vi.doMock('../../src/db', () => ({ getPool: () => ({ query: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) }) }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getQueue } = await import('../../src/queue');
    const q = getQueue();
    q.enqueue([{
      testName: 'test', environment: 'local', version: '1.0',
      url: 'https://example.com', method: 'GET', statusCode: 200,
      responseTimeMs: 100, responseSizeBytes: null, contentType: null, assertions: {}
    }]);
    await q.flush();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[perf]'));
    expect(q.size()).toBe(0);
    warnSpy.mockRestore();
  });
});
```

**Step 2: Run to verify failure**

```bash
npm run test:unit -- tests/unit/queue.test.ts
```

Expected: FAIL — `getQueue` not found.

**Step 3: Create `src/queue.ts`**

```typescript
import { getPool } from './db';
import type { PerfRecord } from './recorder';

export interface QueueRecord extends PerfRecord {
  testName: string;
  environment: string;
  version: string;
}

export interface Queue {
  enqueue(records: QueueRecord[]): void;
  flush(): Promise<void>;
  size(): number;
  start(): void;
  stop(): void;
}

let instance: Queue | null = null;

export function getQueue(): Queue {
  if (instance) return instance;

  const buffer: QueueRecord[] = [];
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, buffer.length);

    const values = batch.map((r, i) => {
      const base = i * 11;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11})`;
    });

    const params = batch.flatMap((r) => [
      r.testName, r.environment, r.version,
      r.url, r.method, r.statusCode,
      r.responseTimeMs, r.responseSizeBytes, r.contentType,
      JSON.stringify(r.assertions), new Date(),
    ]);

    const sql = `
      INSERT INTO performance_measurements
        (test_name, environment, version, url, method, status_code,
         response_time_ms, response_size_bytes, content_type, assertions, recorded_at)
      VALUES ${values.join(', ')}
    `;

    try {
      await getPool().query(sql, params);
    } catch (err) {
      console.warn(`[perf] Failed to write ${batch.length} record(s) to database: ${(err as Error).message}`);
    }
  };

  instance = {
    enqueue(records: QueueRecord[]): void {
      buffer.push(...records);
    },
    flush,
    size(): number {
      return buffer.length;
    },
    start(): void {
      if (!intervalId) {
        intervalId = setInterval(() => { flush().catch(() => {}); }, 5000);
      }
    },
    stop(): void {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },
  };

  return instance;
}
```

**Step 4: Run to verify pass**

```bash
npm run test:unit -- tests/unit/queue.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/queue.ts tests/unit/queue.test.ts
git commit -m "feat: add async write queue with batch postgres inserts"
```

---

### Task 6: Fixture and Context (`fixture.ts`, `context.ts`)

**Files:**
- Create: `src/context.ts`
- Create: `src/fixture.ts`
- Create: `src/globalTeardown.ts`

**Step 1: Create `src/context.ts`**

```typescript
export interface PerfContext {
  name: string;
  env: string;
  version: string;
}

export type UsePerfContext = (ctx: PerfContext) => void;

export function createContextSetter(): { usePerfContext: UsePerfContext; getContext: () => PerfContext | null } {
  let current: PerfContext | null = null;
  return {
    usePerfContext(ctx: PerfContext): void {
      current = ctx;
    },
    getContext(): PerfContext | null {
      return current;
    },
  };
}
```

**Step 2: Create `src/fixture.ts`**

This is the core — extends Playwright's `test` with the auto-use performance fixture.

```typescript
import { test as base, expect } from '@playwright/test';
import { createRecorder } from './recorder';
import { getQueue } from './queue';
import { resolveConfig } from './config';
import { createContextSetter, type UsePerfContext } from './context';

type PerfFixtures = {
  usePerfContext: UsePerfContext;
};

export const test = base.extend<PerfFixtures>({
  usePerfContext: [
    async ({ page }, use, testInfo) => {
      const recorder = createRecorder();
      const { usePerfContext, getContext } = createContextSetter();
      const queue = getQueue();
      const config = resolveConfig();

      queue.start();

      // Attach recorder to page events
      const onRequest = (req: Parameters<typeof recorder.onRequest>[0]) =>
        recorder.onRequest(req, Date.now());
      const onResponse = (res: Parameters<typeof recorder.onResponse>[0]) =>
        recorder.onResponse(res, Date.now());

      page.on('request', onRequest);
      page.on('response', onResponse);

      // Expose usePerfContext to the test
      await use(usePerfContext);

      // Teardown: flush records to queue
      page.off('request', onRequest);
      page.off('response', onResponse);

      const ctx = getContext();
      const testName = ctx?.name ?? testInfo.title;
      const environment = ctx?.env ?? config.environment;
      const version = ctx?.version ?? config.version;

      const queueRecords = recorder.records.map((r) => ({
        ...r,
        testName,
        environment,
        version,
      }));

      queue.enqueue(queueRecords);

      // Optional verbose output
      if (process.env.PERF_VERBOSE === 'true') {
        console.log(`\n[perf] ${testName} (${environment}@${version})`);
        for (const r of recorder.records) {
          const size = r.responseSizeBytes ? `${(r.responseSizeBytes / 1024).toFixed(1)}kb` : '-';
          console.log(`  ${r.method.padEnd(6)} ${r.url.substring(0, 80).padEnd(80)} ${r.statusCode}  ${r.responseTimeMs}ms  ${size}`);
        }
      }
    },
    { auto: true },
  ],
});

export { expect };
```

**Step 3: Create `src/globalTeardown.ts`**

Ensures the queue is fully drained before the process exits.

```typescript
import { getQueue } from './queue';
import { closePool } from './db';

export default async function globalTeardown(): Promise<void> {
  const queue = getQueue();
  queue.stop();
  await queue.flush();
  await closePool();
}
```

**Step 4: Commit**

```bash
git add src/context.ts src/fixture.ts src/globalTeardown.ts
git commit -m "feat: add auto-use perf fixture and global teardown"
```

---

### Task 7: Example Regression Test

**Files:**
- Create: `tests/example.spec.ts`

**Step 1: Create `tests/example.spec.ts`**

```typescript
import { test, expect } from '../src/fixture';

test('example.com homepage loads with correct content', async ({ page, usePerfContext }) => {
  usePerfContext({ name: 'example-com-homepage', env: 'prod', version: '1.0.0' });

  await page.goto('https://example.com');

  await expect(page.locator('h1')).toHaveText('Example Domain');
  await expect(page.locator('p a')).toHaveAttribute('href', 'https://www.iana.org/domains/reserved');
});
```

**Step 2: Run the test (requires network access)**

```bash
npx playwright test tests/example.spec.ts --reporter=line
```

Expected: PASS with 1 test passing. If `PERF_VERBOSE=true`, you'll see HTTP metrics printed.

**Step 3: Run with verbose output to verify recording works**

```bash
PERF_VERBOSE=true npx playwright test tests/example.spec.ts --reporter=line
```

Expected: Console output showing recorded requests (at minimum the `example.com` navigation request).

**Step 4: Commit**

```bash
git add tests/example.spec.ts
git commit -m "feat: add example regression test against example.com"
```

---

### Task 8: Run All Tests and Verify

**Step 1: Run unit tests**

```bash
npm run test:unit
```

Expected: All unit tests PASS.

**Step 2: Run e2e tests**

```bash
npm run test:e2e
```

Expected: 1 test PASS.

**Step 3: Run all tests**

```bash
npm test
```

Expected: All PASS.

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: verify all tests pass"
```

---

## Notes for Implementer

- **Postgres not required to run tests** — the queue silently drops records if DB is unavailable. The regression test passes regardless.
- **To set up Postgres locally:** Run `createdb perf_metrics` then `npm run db:init` (after setting `PG_USER`, `PG_PASSWORD` etc. or using `DATABASE_URL`).
- **TimescaleDB:** The schema is compatible — after creating the table, run `SELECT create_hypertable('performance_measurements', 'recorded_at');` to enable time-series optimizations.
- **Vitest config:** No separate `vitest.config.ts` needed — vitest picks up `tsconfig.json` automatically. Test files in `tests/unit/` are discovered by the `**/*.test.ts` glob.
