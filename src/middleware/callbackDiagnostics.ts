import { randomUUID } from 'node:crypto';
import { appendFile, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Request, Response, NextFunction } from 'express';

// Operational metadata only: never write query strings, credentials or payloads.
export function callbackDiagnostics(req: Request, res: Response, next: NextFunction) {
  if (!['/api/orders/c2b-callback', '/api/orders/c2b-callback/validation'].includes(req.path)) return next();
  const requestPath = req.path;
  const requestId = randomUUID();
  const started = Date.now();
  const write = (stage: string) => {
    const entry = JSON.stringify({ time: new Date().toISOString(), requestId,
      method: req.method, path: requestPath, stage,
      ...(stage === 'finished' ? { status: res.statusCode, outcome: res.locals.c2bOutcome ?? 'before_handler', durationMs: Date.now() - started } : {}),
    });
    console.info('[C2B diagnostic]', entry);
    try {
      const directory = resolve(process.cwd(), 'logs');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      appendFile(resolve(directory, 'mpesa-callbacks.ndjson'), entry + '\n', { mode: 0o600 }, error => {
        if (error) console.error('[C2B diagnostic] Unable to persist diagnostic record');
      });
    } catch { console.error('[C2B diagnostic] Unable to open diagnostic directory'); }
  };
  write('received');
  res.once('finish', () => write('finished'));
  next();
}
