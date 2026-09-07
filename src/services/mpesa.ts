import crypto from 'crypto';

type MpesaConfig = {
  consumerKey: string;
  consumerSecret: string;
  shortCode: string;
  passkey: string;
  callbackUrl: string;
  callbackSecret: string;
  environment: 'sandbox' | 'production';
};

export type MpesaPushResult = {
  checkoutRequestId: string;
  merchantRequestId: string;
};

function requiredConfig(): MpesaConfig | null {
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
  const shortCode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  const callbackUrl = process.env.MPESA_CALLBACK_URL;
  const callbackSecret = process.env.MPESA_CALLBACK_SECRET;
  const environment = process.env.MPESA_ENV === 'production' ? 'production' : 'sandbox';

  if (!consumerKey || !consumerSecret || !shortCode || !passkey || !callbackUrl || !callbackSecret) {
    return null;
  }

  const url = new URL(callbackUrl);
  if (url.protocol !== 'https:' && environment === 'production') {
    throw new Error('MPESA_CALLBACK_URL must use HTTPS in production');
  }

  return { consumerKey, consumerSecret, shortCode, passkey, callbackUrl, callbackSecret, environment };
}

export function isMpesaConfigured(): boolean {
  try {
    return requiredConfig() !== null;
  } catch {
    return false;
  }
}

export function callbackSecretMatches(candidate: unknown): boolean {
  const config = requiredConfig();
  if (!config || typeof candidate !== 'string' || candidate.length > 256) return false;

  const expected = Buffer.from(config.callbackSecret);
  const received = Buffer.from(candidate);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

function timestamp(): string {
  // Daraja expects YYYYMMDDHHmmss in Kenya time. Do not depend on the API
  // host's local timezone, which is often UTC in cloud deployments.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || '';
  return `${value('year')}${value('month')}${value('day')}${value('hour')}${value('minute')}${value('second')}`;
}

function normalizedPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length === 10) return `254${digits.slice(1)}`;
  if (digits.startsWith('254') && digits.length === 12) return digits;
  if (digits.startsWith('7') && digits.length === 9) return `254${digits}`;
  throw new Error('M-PESA phone number is invalid');
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`M-PESA request failed with HTTP ${response.status}`);
  return body;
}

export async function initiateMpesaStkPush(input: {
  orderNumber: string;
  amount: number;
  phone: string;
}): Promise<MpesaPushResult> {
  const config = requiredConfig();
  if (!config) throw new Error('M-PESA is not configured');

  const baseUrl = config.environment === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
  const authorization = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString('base64');
  const tokenResponse = await fetchJson(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    method: 'GET',
    headers: { Authorization: `Basic ${authorization}` },
  }) as { access_token?: unknown };

  if (typeof tokenResponse.access_token !== 'string' || !tokenResponse.access_token) {
    throw new Error('M-PESA OAuth response did not include an access token');
  }

  const requestTimestamp = timestamp();
  const password = Buffer.from(`${config.shortCode}${config.passkey}${requestTimestamp}`).toString('base64');
  const callback = new URL(config.callbackUrl);
  // Daraja callbacks do not carry a request signature. This high-entropy secret
  // binds the callback to this installation and is never written to logs.
  callback.searchParams.set('token', config.callbackSecret);

  const pushResponse = await fetchJson(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenResponse.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      BusinessShortCode: config.shortCode,
      Password: password,
      Timestamp: requestTimestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(input.amount),
      PartyA: normalizedPhone(input.phone),
      PartyB: config.shortCode,
      PhoneNumber: normalizedPhone(input.phone),
      CallBackURL: callback.toString(),
      AccountReference: input.orderNumber,
      TransactionDesc: `Order ${input.orderNumber}`.slice(0, 50),
    }),
  }) as { ResponseCode?: unknown; CheckoutRequestID?: unknown; MerchantRequestID?: unknown };

  if (
    pushResponse.ResponseCode !== '0' ||
    typeof pushResponse.CheckoutRequestID !== 'string' ||
    typeof pushResponse.MerchantRequestID !== 'string'
  ) {
    throw new Error('M-PESA rejected the payment request');
  }

  return {
    checkoutRequestId: pushResponse.CheckoutRequestID,
    merchantRequestId: pushResponse.MerchantRequestID,
  };
}

export function normalizeMpesaPhone(phone: string): string | null {
  try {
    return normalizedPhone(phone);
  } catch {
    return null;
  }
}
