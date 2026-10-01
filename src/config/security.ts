import { assertMfaEncryptionKey, ownerMfaRequired } from '../services/mfa';

function requireStrongSecret(name: string, value: string | undefined): string {
  const secret = value?.trim() ?? '';
  if (secret.length < 32 || /replace|example|change[-_ ]?me|development/i.test(secret)) {
    throw new Error(`${name} must be a unique production secret of at least 32 characters.`);
  }
  return secret;
}

function requireProductionValue(name: string, value: string | undefined): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) throw new Error(`${name} is required when MPESA_ENV=production.`);
  return normalized;
}

function requireHttpsCallback(name: string, value: string | undefined): void {
  const url = new URL(requireProductionValue(name, value));
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(`${name} must be an HTTPS URL without credentials or a fragment.`);
  }
}

function validateProductionMpesa(env: NodeJS.ProcessEnv): void {
  if (env.MPESA_ENV !== 'production') return;
  requireProductionValue('MPESA_CONSUMER_KEY', env.MPESA_CONSUMER_KEY);
  requireProductionValue('MPESA_CONSUMER_SECRET', env.MPESA_CONSUMER_SECRET);
  const shortcode = requireProductionValue('MPESA_SHORTCODE', env.MPESA_SHORTCODE);
  const till = requireProductionValue('MPESA_TILL_NUMBER', env.MPESA_TILL_NUMBER);
  if (!/^\d{5,12}$/.test(shortcode) || !/^\d{5,12}$/.test(till)) {
    throw new Error('MPESA_SHORTCODE and MPESA_TILL_NUMBER must contain 5 to 12 digits.');
  }
  requireHttpsCallback('MPESA_C2B_CALLBACK_URL', env.MPESA_C2B_CALLBACK_URL);
  requireStrongSecret('MPESA_C2B_CALLBACK_SECRET', env.MPESA_C2B_CALLBACK_SECRET);
}

function requireHttpsOrigin(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required in production.`);
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`${name} must be an HTTPS origin without credentials, path, query, or fragment.`);
  }
  return url.origin;
}

export function resolveTrustProxy(env: NodeJS.ProcessEnv = process.env): false | number {
  if (env.NODE_ENV !== 'production') return false;
  if (!/^\d+$/.test(env.TRUST_PROXY_HOPS ?? '')) {
    throw new Error('TRUST_PROXY_HOPS is required in production and must be an integer from 0 to 5.');
  }
  const hops = Number(env.TRUST_PROXY_HOPS);
  if (!Number.isInteger(hops) || hops < 0 || hops > 5) {
    throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 5.');
  }
  return hops === 0 ? false : hops;
}

export function validateProductionSecurityEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;

  const jwt = requireStrongSecret('JWT_SECRET', env.JWT_SECRET);
  const pos = requireStrongSecret('POS_SESSION_SECRET', env.POS_SESSION_SECRET);
  if (jwt === pos) throw new Error('JWT_SECRET and POS_SESSION_SECRET must be different secrets.');

  const origins = [
    requireHttpsOrigin('STOREFRONT_URL', env.STOREFRONT_URL),
    requireHttpsOrigin('ADMIN_URL', env.ADMIN_URL),
    requireHttpsOrigin('POS_URL', env.POS_URL),
  ];
  if (new Set(origins).size !== origins.length) {
    throw new Error('STOREFRONT_URL, ADMIN_URL, and POS_URL must use separate origins.');
  }

  resolveTrustProxy(env);
  validateProductionMpesa(env);
  if (ownerMfaRequired(env)) assertMfaEncryptionKey(env.MFA_ENCRYPTION_KEY);
}
