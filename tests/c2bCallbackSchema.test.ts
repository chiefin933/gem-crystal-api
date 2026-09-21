import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseC2BCallback } from '../src/routes/orders';

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
