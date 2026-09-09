/**
 * M-PESA C2B (Customer-to-Business / Till payment) service.
 *
 * Architecture
 * ────────────────────────────────────────────────────────────────────────
 * The customer walks up to the POS (or checks out online) and independently
 * pays the Gem & Crystal Buy Goods Till number via their M-PESA menu:
 *
 *   Lipa na M-PESA → Buy Goods → Enter Till number → Enter amount → PIN
 *
 * Safaricom then sends a real-time payment notification to our C2B callback.
 * We verify it and match it to the pending order/POS sale.
 *
 * This replaces the STK Push flow where we had to prompt the customer.
 *
 * C2B Registration
 * ────────────────
 * Before receiving callbacks, the Till must be registered with Daraja:
 *   POST /api/orders/mpesa-c2b-register  (owner-only, run once)
 *
 * C2B Callback
 * ────────────
 * Safaricom hits our endpoint with:
 *   TransactionType, TransID, TransTime, TransAmount,
 *   BusinessShortCode, BillRefNumber, MSISDN, FirstName, ...
 *
 * We correlate the payment to a pending sale using:
 *   1. BillRefNumber (receipt number the cashier/order tells the customer)
 *   2. Amount match (within tolerance)
 *   3. Phone match where available
 *   4. If no safe match → UnmatchedPayment for owner review
 */

import crypto from 'crypto';

export interface C2BPayload {
  TransactionType: string;
  TransID: string;
  TransTime: string;
  TransAmount: string;
  BusinessShortCode: string;
  BillRefNumber: string;
  InvoiceNumber?: string;
  OrgAccountBalance?: string;
  ThirdPartyTransID?: string;
  MSISDN: string;
  FirstName?: string;
  MiddleName?: string;
  LastName?: string;
}

/** Returns the Till number configured for this deployment. */
export function getTillNumber(): string | null {
  return process.env.MPESA_TILL_NUMBER?.trim() || null;
}

/** Returns true when all C2B config is present. */
export function isC2BConfigured(): boolean {
  return !!(
    process.env.MPESA_CONSUMER_KEY &&
    process.env.MPESA_CONSUMER_SECRET &&
    process.env.MPESA_SHORTCODE &&
    process.env.MPESA_CALLBACK_URL &&
    process.env.MPESA_CALLBACK_SECRET &&
    getTillNumber()
  );
}

/** Timing-safe comparison of the C2B callback secret. */
export function c2bSecretMatches(candidate: unknown): boolean {
  const secret = process.env.MPESA_CALLBACK_SECRET;
  if (!secret || typeof candidate !== 'string' || candidate.length > 256) return false;
  const expected = Buffer.from(secret);
  const received = Buffer.from(candidate);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Daraja request failed with HTTP ${response.status}`);
  return body;
}

async function getAccessToken(): Promise<string> {
  const consumerKey = process.env.MPESA_CONSUMER_KEY!;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET!;
  const env = process.env.MPESA_ENV === 'production' ? 'production' : 'sandbox';
  const base = env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

  const res = await fetchJson(`${base}/oauth/v1/generate?grant_type=client_credentials`, {
    method: 'GET',
    headers: { Authorization: `Basic ${auth}` },
  }) as { access_token?: string };

  if (!res.access_token) throw new Error('No access token in Daraja OAuth response');
  return res.access_token;
}

/**
 * Register the C2B callback URLs with Daraja.
 * Must be called once (or when callback URL changes) before payments arrive.
 */
export async function registerC2BUrls(): Promise<{ ResponseCode: string; ResponseDescription: string }> {
  const env = process.env.MPESA_ENV === 'production' ? 'production' : 'sandbox';
  const base = env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
  const token = await getAccessToken();
  const callbackUrl = process.env.MPESA_CALLBACK_URL!;
  const secret = process.env.MPESA_CALLBACK_SECRET!;

  // Embed secret as query param (same pattern as STK callback)
  const confirmUrl = `${callbackUrl}?token=${secret}`;
  const validationUrl = `${callbackUrl}/validation?token=${secret}`;

  const res = await fetchJson(`${base}/mpesa/c2b/v1/registerurl`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ShortCode: process.env.MPESA_SHORTCODE,
      ResponseType: 'Completed',
      ConfirmationURL: confirmUrl,
      ValidationURL: validationUrl,
    }),
  }) as any;

  return res;
}

/**
 * Normalize a phone number from a C2B callback to E.164 format.
 * Daraja typically sends MSISDN in 2547XXXXXXXX format.
 */
export function normalizeC2BPhone(msisdn: string): string {
  const digits = msisdn.replace(/\D/g, '');
  if (digits.startsWith('254') && digits.length === 12) return `+${digits}`;
  if (digits.startsWith('0') && digits.length === 10) return `+254${digits.slice(1)}`;
  if (digits.startsWith('7') && digits.length === 9) return `+254${digits}`;
  return `+${digits}`;
}
