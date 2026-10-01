import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseC2BCallback } from '../src/routes/orders';
import { normalizeC2BPhone } from '../src/services/mpesaC2B';

const payload = {
  TransactionType: 'Buy Goods',
  TransID: 'TESTRECEIPT1',
  TransTime: '20260922020100',
  TransAmount: '1',
  BusinessShortCode: '600986',
  MSISDN: '254708374149',
};

test('normalizes a Buy Goods AccountReference into BillRefNumber', () => {
  const result = parseC2BCallback({ ...payload, AccountReference: ' GCPOS123 ' });
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.BillRefNumber, 'GCPOS123');
});

test('continues accepting the legacy BillRefNumber callback field', () => {
  const result = parseC2BCallback({ ...payload, BillRefNumber: 'GCPOS456' });
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.BillRefNumber, 'GCPOS456');
});

test('accepts and labels a SHA-256 MSISDN from the C2B v1 sandbox', () => {
  const hashedMsisdn = '94c2c311d522da950619227b3361752a42042db7e1e699b26e628305c68a88';
  const result = parseC2BCallback({ ...payload, MSISDN: hashedMsisdn });
  assert.equal(result.success, true);
  assert.equal(normalizeC2BPhone(hashedMsisdn), `sha256:${hashedMsisdn}`);
});

test('accepts and labels a masked C2B v2 MSISDN', () => {
  const maskedMsisdn = '2547 * 126';
  const result = parseC2BCallback({ ...payload, MSISDN: maskedMsisdn });
  assert.equal(result.success, true);
  assert.equal(normalizeC2BPhone(maskedMsisdn), 'masked:2547*126');
});

test('still normalizes a real Kenyan MSISDN to E.164', () => {
  assert.equal(normalizeC2BPhone('254708374149'), '+254708374149');
});
