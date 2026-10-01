import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMfaSetup,
  decryptMfaSecret,
  encryptMfaSecret,
  findRecoveryCodeHash,
  generateRecoveryCodes,
  generateTotpForTest,
  hashRecoveryCode,
  normaliseRecoveryCode,
  ownerMfaRequired,
  parseRecoveryCodeHashes,
  validateTotp,
} from '../src/services/mfa';
import {
  resolveTrustProxy,
  validateProductionSecurityEnvironment,
} from '../src/config/security';

const MFA_KEY = Buffer.alloc(32, 7).toString('base64');
const STRONG_JWT = 'jwt-secret-that-is-unique-and-at-least-32-characters';
const STRONG_POS = 'pos-secret-that-is-unique-and-at-least-32-characters';

test('MFA secrets encrypt round-trip and reject tampering', () => {
  const encrypted = encryptMfaSecret('JBSWY3DPEHPK3PXP', MFA_KEY);
  assert.notEqual(encrypted, 'JBSWY3DPEHPK3PXP');
  assert.equal(decryptMfaSecret(encrypted, MFA_KEY), 'JBSWY3DPEHPK3PXP');

  const parts = encrypted.split(':');
  parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
  assert.throws(() => decryptMfaSecret(parts.join(':'), MFA_KEY));
});

test('TOTP validation accepts the current code and rejects malformed codes', () => {
  const setup = createMfaSetup('owner@example.com');
  const timestamp = 1_800_000_000_000;
  const token = generateTotpForTest(setup.secret, 'owner@example.com', timestamp);
  assert.match(setup.otpauthUri, /^otpauth:\/\/totp\//);
  assert.equal(typeof validateTotp(setup.secret, 'owner@example.com', token, timestamp), 'number');
  assert.equal(validateTotp(setup.secret, 'owner@example.com', 'abcdef', timestamp), null);
});

test('recovery codes are normalised, hashed, parsed, and timing-safe matched', () => {
  const previous = process.env.MFA_ENCRYPTION_KEY;
  process.env.MFA_ENCRYPTION_KEY = MFA_KEY;
  try {
    const recovery = generateRecoveryCodes(4);
    assert.equal(recovery.codes.length, 4);
    assert.equal(new Set(recovery.codes).size, 4);
    assert.equal(normaliseRecoveryCode(recovery.codes[0].toLowerCase()), recovery.codes[0].replaceAll('-', ''));
    assert.equal(hashRecoveryCode(recovery.codes[0]), recovery.hashes[0]);
    assert.equal(findRecoveryCodeHash(recovery.hashes, recovery.codes[0].toLowerCase()), recovery.hashes[0]);
    assert.equal(findRecoveryCodeHash(recovery.hashes, 'WRONG-CODE'), null);
    assert.deepEqual(parseRecoveryCodeHashes(JSON.stringify(recovery.hashes)), recovery.hashes);
    assert.deepEqual(parseRecoveryCodeHashes('not-json'), []);
  } finally {
    if (previous === undefined) delete process.env.MFA_ENCRYPTION_KEY;
    else process.env.MFA_ENCRYPTION_KEY = previous;
  }
});

test('owner MFA defaults on in production and can be explicitly enabled in development', () => {
  assert.equal(ownerMfaRequired({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), true);
  assert.equal(ownerMfaRequired({ NODE_ENV: 'production', OWNER_MFA_REQUIRED: 'false' } as NodeJS.ProcessEnv), true);
  assert.equal(ownerMfaRequired({ NODE_ENV: 'development' } as NodeJS.ProcessEnv), false);
  assert.equal(ownerMfaRequired({ NODE_ENV: 'development', OWNER_MFA_REQUIRED: 'true' } as NodeJS.ProcessEnv), true);
});

test('production configuration accepts separate HTTPS origins and explicit proxy hops', () => {
  const env = {
    NODE_ENV: 'production',
    JWT_SECRET: STRONG_JWT,
    POS_SESSION_SECRET: STRONG_POS,
    STOREFRONT_URL: 'https://shop.example.com',
    ADMIN_URL: 'https://admin.example.com',
    POS_URL: 'https://pos.example.com',
    TRUST_PROXY_HOPS: '1',
    OWNER_MFA_REQUIRED: 'true',
    MFA_ENCRYPTION_KEY: MFA_KEY,
  } as NodeJS.ProcessEnv;

  assert.doesNotThrow(() => validateProductionSecurityEnvironment(env));
  assert.equal(resolveTrustProxy(env), 1);
});

test('production configuration rejects shared secrets, insecure origins, and implicit proxy trust', () => {
  const base = {
    NODE_ENV: 'production',
    JWT_SECRET: STRONG_JWT,
    POS_SESSION_SECRET: STRONG_POS,
    STOREFRONT_URL: 'https://shop.example.com',
    ADMIN_URL: 'https://admin.example.com',
    POS_URL: 'https://pos.example.com',
    TRUST_PROXY_HOPS: '1',
    OWNER_MFA_REQUIRED: 'true',
    MFA_ENCRYPTION_KEY: MFA_KEY,
  } as NodeJS.ProcessEnv;

  assert.throws(() => validateProductionSecurityEnvironment({ ...base, POS_SESSION_SECRET: STRONG_JWT }));
  assert.throws(() => validateProductionSecurityEnvironment({ ...base, ADMIN_URL: 'http://admin.example.com' }));
  assert.throws(() => validateProductionSecurityEnvironment({ ...base, TRUST_PROXY_HOPS: undefined }));
});
test('live M-Pesa configuration fails closed when credentials or callback security are incomplete', () => {
  const base = {
    NODE_ENV: 'production',
    JWT_SECRET: STRONG_JWT,
    POS_SESSION_SECRET: STRONG_POS,
    STOREFRONT_URL: 'https://shop.example.com',
    ADMIN_URL: 'https://admin.example.com',
    POS_URL: 'https://pos.example.com',
    TRUST_PROXY_HOPS: '1',
    OWNER_MFA_REQUIRED: 'true',
    MFA_ENCRYPTION_KEY: MFA_KEY,
    MPESA_ENV: 'production',
    MPESA_CONSUMER_KEY: 'consumer-key',
    MPESA_CONSUMER_SECRET: 'consumer-secret',
    MPESA_SHORTCODE: '123456',
    MPESA_TILL_NUMBER: '654321',
    MPESA_C2B_CALLBACK_URL: 'https://api.example.com/api/orders/c2b-callback',
    MPESA_C2B_CALLBACK_SECRET: 'a-live-callback-secret-with-at-least-32-chars',
  } as NodeJS.ProcessEnv;

  assert.doesNotThrow(() => validateProductionSecurityEnvironment(base));
  assert.throws(() => validateProductionSecurityEnvironment({ ...base, MPESA_CONSUMER_KEY: undefined }));
  assert.throws(() => validateProductionSecurityEnvironment({ ...base, MPESA_C2B_CALLBACK_URL: 'http://api.example.com/callback' }));
  assert.throws(() => validateProductionSecurityEnvironment({ ...base, MPESA_C2B_CALLBACK_SECRET: 'short' }));
  assert.throws(() => validateProductionSecurityEnvironment({ ...base, MPESA_TILL_NUMBER: 'not-digits' }));
});
