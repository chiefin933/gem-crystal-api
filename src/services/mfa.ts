import crypto from 'node:crypto';
import * as OTPAuth from 'otpauth';

const MFA_ISSUER = 'Gem & Crystal Fashion Hub';
const MFA_ALGORITHM = 'SHA1';
const MFA_DIGITS = 6;
const MFA_PERIOD_SECONDS = 30;
const ENCRYPTION_VERSION = 'v1';

function decodeEncryptionKey(raw = process.env.MFA_ENCRYPTION_KEY): Buffer {
  if (!raw) {
    throw new Error('MFA_ENCRYPTION_KEY is required for owner MFA. Use 32 random bytes encoded as base64 or 64 hexadecimal characters.');
  }

  const trimmed = raw.trim();
  const key = /^[a-f0-9]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');

  if (key.length !== 32) {
    throw new Error('MFA_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  }
  return key;
}

export function ownerMfaRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'production') return true;
  return env.OWNER_MFA_REQUIRED?.trim().toLowerCase() === 'true';
}

export function assertMfaEncryptionKey(raw = process.env.MFA_ENCRYPTION_KEY): void {
  decodeEncryptionKey(raw);
}

export function encryptMfaSecret(secret: string, rawKey = process.env.MFA_ENCRYPTION_KEY): string {
  const key = decodeEncryptionKey(rawKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENCRYPTION_VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
}

export function decryptMfaSecret(value: string, rawKey = process.env.MFA_ENCRYPTION_KEY): string {
  const [version, ivText, tagText, ciphertextText, ...extra] = value.split(':');
  if (version !== ENCRYPTION_VERSION || !ivText || !tagText || !ciphertextText || extra.length > 0) {
    throw new Error('Stored MFA secret has an invalid format.');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', decodeEncryptionKey(rawKey), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function totpFor(secret: string, email: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: MFA_ISSUER,
    label: email,
    algorithm: MFA_ALGORITHM,
    digits: MFA_DIGITS,
    period: MFA_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}

export function createMfaSetup(email: string): { secret: string; otpauthUri: string } {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  return { secret, otpauthUri: totpFor(secret, email).toString() };
}

export function generateTotpForTest(secret: string, email: string, timestamp = Date.now()): string {
  return totpFor(secret, email).generate({ timestamp });
}

export function validateTotp(secret: string, email: string, token: string, timestamp = Date.now()): number | null {
  if (!/^\d{6}$/.test(token)) return null;
  const totp = totpFor(secret, email);
  const delta = totp.validate({ token, timestamp, window: 1 });
  return delta == null ? null : totp.counter({ timestamp }) + delta;
}

export function normaliseRecoveryCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashRecoveryCode(value: string, rawKey = process.env.MFA_ENCRYPTION_KEY): string {
  return crypto.createHmac('sha256', decodeEncryptionKey(rawKey)).update(normaliseRecoveryCode(value)).digest('hex');
}

export function generateRecoveryCodes(count = 10): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: count }, () => {
    const raw = crypto.randomBytes(10).toString('hex').toUpperCase();
    return raw.match(/.{1,4}/g)!.join('-');
  });
  return { codes, hashes: codes.map(code => hashRecoveryCode(code)) };
}

export function parseRecoveryCodeHashes(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(item => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item))
      ? parsed
      : [];
  } catch {
    return [];
  }
}

export function findRecoveryCodeHash(storedHashes: string[], candidate: string): string | null {
  const candidateHash = Buffer.from(hashRecoveryCode(candidate), 'hex');
  return storedHashes.find(stored => {
    const storedHash = Buffer.from(stored, 'hex');
    return storedHash.length === candidateHash.length && crypto.timingSafeEqual(storedHash, candidateHash);
  }) ?? null;
}
