import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callbackDiagnostics } from '../src/middleware/callbackDiagnostics';

test('callback diagnostics preserve arrival path and exclude secrets and payloads', async () => {
  const previous = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'gem-callback-diagnostics-'));
  process.chdir(dir);
  try {
    const req: any = { method: 'POST', path: '/api/orders/c2b-callback', originalUrl: '/api/orders/c2b-callback?token=SECRET', body: { MSISDN: 'PRIVATE_PHONE' } };
    const res: any = new EventEmitter(); res.locals = {}; res.statusCode = 200;
    let nextCalls = 0;
    callbackDiagnostics(req, res, () => { nextCalls++; });
    req.path = '/c2b-callback'; res.locals.c2bOutcome = 'processed'; res.emit('finish');
    let records: any[] = [];
    for (let i = 0; i < 50; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      try { records = readFileSync(join(dir, 'logs/mpesa-callbacks.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch {}
      if (records.length === 2) break;
    }
    assert.equal(nextCalls, 1); assert.equal(records.length, 2);
    assert.equal(records[0].requestId, records[1].requestId);
    assert.ok(records.every(record => record.path === '/api/orders/c2b-callback'));
    assert.equal(records.find(record => record.stage === 'finished').outcome, 'processed');
    assert.doesNotMatch(JSON.stringify(records), /SECRET|PRIVATE_PHONE|originalUrl/);
  } finally { process.chdir(previous); rmSync(dir, { recursive: true, force: true }); }
});
