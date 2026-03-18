# Playwright Performance Fixture — Design

**Date:** 2026-03-18
**Status:** Approved

## Overview

A Playwright fixture library that automatically captures HTTP performance metrics for every regression test that imports it. Metrics are written to a Postgres timeseries database. Tests remain standard regression tests; performance recording is fully transparent.

## Architecture

```
reg-test-performance-fixture/
├── src/
│   ├── fixture.ts          # perfFixture definition, auto-uses on every test
│   ├── context.ts          # usePerfContext() — sets name/env/version per test
│   ├── recorder.ts         # page.on('response') handler, captures metrics
│   ├── queue.ts            # async write queue, batches inserts, flushes at teardown
│   ├── db.ts               # Postgres client, connection config resolution
│   └── schema.ts           # SQL for creating the timeseries table
├── db/
│   └── init.sql            # Standalone SQL script for schema setup
├── tests/
│   └── example.spec.ts     # Sample regression test against example.com
├── perf.config.json        # Default perf config (overridden by env vars)
├── playwright.config.ts
├── package.json
└── tsconfig.json
```

## Fixture Approach

**Option A — Single auto-fixture** was chosen. `perfFixture` is auto-applied to every test via Playwright's `auto: true` fixture option. Tests opt into metadata via `usePerfContext()` inside the test body. No manual wrapping of actions required.

Rejected alternatives:
- **Worker-scoped fixture**: better connection pooling but less ergonomic API; overkill for this use case
- **Reporter plugin**: requires trace files, adds post-processing latency, loses inline assertion capability

## API

```typescript
// tests/example.spec.ts
import { test, expect } from '../src/fixture';

test('example.com homepage loads', async ({ page, usePerfContext }) => {
  usePerfContext({ name: 'example-com-homepage', env: 'prod', version: '1.0.0' });

  await page.goto('https://example.com');
  await expect(page.locator('h1')).toHaveText('Example Domain');
});
```

- `test` — extended Playwright test object with `perfFixture` included
- `usePerfContext({ name, env, version })` — sets metadata for the current test; if omitted, falls back to Playwright test title + config/env var defaults
- No other imports required — recording is fully automatic

## Configuration

Priority order (highest to lowest):

1. Environment variables: `DATABASE_URL`, `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `PG_DB`, `PERF_ENV`, `PERF_VERSION`
2. `perf.config.json` in the project root

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

## Recording

- `page.on('request')` + `page.on('response')` paired by request object reference to measure latency
- Captures per response: URL, HTTP method, status code, response time (ms), response size (bytes), content-type, selected headers (stored as JSONB `assertions`)
- Captures **all** requests on the page (navigation, API, assets, third-party) — filtering can be added later
- Records held in a per-test in-memory array until teardown

## Write Queue

- Module-level singleton queue (shared across tests in a process)
- Flushes every 5 seconds via `setInterval`
- At test teardown: fixture pushes buffered records (with metadata) into the queue
- Queue drains fully on process exit via Playwright `globalTeardown`
- Flush strategy: single multi-row `INSERT` per batch using `pg` (node-postgres)
- On DB unavailability: logs a single `console.warn`, discards batch, test continues normally

## Database Schema

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

Compatible with TimescaleDB hypertable conversion if needed in future.

## Console Output

When `PERF_VERBOSE=true` is set, a summary table is printed to stdout after each test:

```
[perf] example-com-homepage (prod@1.0.0)
  GET  https://example.com/          200   312ms   14.2kb
  GET  https://example.com/style.css 200    88ms    3.1kb
```

Otherwise, no output — stats live in Postgres only.

## Example Test

Target: `https://example.com` (stable IANA-maintained site, no auth, no rate limiting).

```typescript
test('example.com homepage loads with correct content', async ({ page, usePerfContext }) => {
  usePerfContext({ name: 'example-com-homepage', env: 'prod', version: '1.0.0' });

  await page.goto('https://example.com');
  await expect(page.locator('h1')).toHaveText('Example Domain');
  await expect(page.locator('p a')).toHaveAttribute('href', 'https://www.iana.org/domains/reserved');
});
```

## Dependencies

- `@playwright/test` — test runner and fixture system
- `pg` — node-postgres client
- TypeScript + `ts-node` for config/setup scripts
