import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { registerC2BUrls } from '../src/services/mpesaC2B';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let providerResponse: unknown;
let registered: any;

beforeEach(() => {
  process.env.MPESA_ENV = 'sandbox';
  process.env.MPESA_CONSUMER_KEY = 'test';
  process.env.MPESA_CONSUMER_SECRET = 'test';
  process.env.MPESA_SHORTCODE = '600000';
  process.env.MPESA_C2B_CALLBACK_URL = 'https://example.test/api/orders/c2b-callback';
  process.env.MPESA_C2B_CALLBACK_SECRET = 'secret+with/slash=and&query';
  registered = null;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (url.includes('/oauth/')) return Response.json({ access_token: 'test-token' });
    registered = JSON.parse(String(init.body));
    return Response.json(providerResponse);
  }) as typeof fetch;
});

afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; });

test('registration preserves encoded secrets and checks provider success', async () => {
  providerResponse = { ResponseCode: '0', ResponseDescription: 'Success' };
  assert.equal((await registerC2BUrls()).ResponseCode, '0');
  const confirmation = new URL(registered.ConfirmationURL);
  const validation = new URL(registered.ValidationURL);
  assert.equal(confirmation.pathname, '/api/orders/c2b-callback');
  assert.equal(validation.pathname, '/api/orders/c2b-callback/validation');
  for (const url of [confirmation, validation]) {
    assert.equal(url.searchParams.get('token'), process.env.MPESA_C2B_CALLBACK_SECRET);
  }
  assert.equal(registered.ShortCode, '600000');
  providerResponse = { ResponseCode: '00000000' };
  assert.equal((await registerC2BUrls()).ResponseCode, '00000000');
});

test('HTTP 200 provider errors and malformed responses cannot report registration success', async () => {
  for (const body of [{ errorCode: '400.003.01' }, { ResponseCode: '1' }, {}, null]) {
    providerResponse = body;
    await assert.rejects(registerC2BUrls(), /did not confirm/);
  }
});
