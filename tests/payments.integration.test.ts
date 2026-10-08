import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { processC2BPayment } from '../src/services/paymentSettlement';

// Explicit isolated database only. Never fall back to the application's .env.
const url = process.env.TEST_DATABASE_URL;
if (!url || !['localhost', '127.0.0.1'].includes(new URL(url).hostname) || !new URL(url).pathname.includes('tests')) {
  throw new Error('Set TEST_DATABASE_URL to a disposable localhost database with "tests" in its name');
}
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = 'isolated-test-signing-secret-not-for-deployment';
process.env.MPESA_SHORTCODE = '600000';
process.env.MPESA_C2B_CALLBACK_SECRET = 'test-callback-secret';
process.env.MPESA_C2B_CALLBACK_URL = 'https://example.test/api/orders/c2b-callback';
process.env.MPESA_CONSUMER_KEY = 'test';
process.env.MPESA_CONSUMER_SECRET = 'test';
process.env.MPESA_TILL_NUMBER = '123456';
let db: any, server: any, base: string, ownerToken: string;
const trackingToken = 'customer-private-token';
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

before(async () => {
  db = (await import('../src/lib/prisma')).prisma;
  const app = express(); app.use(express.json());
  app.use('/orders', (await import('../src/routes/orders')).default);
  app.use('/pos', (await import('../src/routes/pos')).default);
  app.use((await import('../src/middleware/errorHandler')).errorHandler);
  server = await new Promise<any>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise<void>(resolve => server?.close(() => resolve())); await db?.$disconnect(); });
beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE "CheckoutSession", "Order", "PosSale", "SalePayment", "PaymentNotification", "UnmatchedPayment", "Product", "Variant", "Coupon", "Customer", "InventoryMovement", "AuditLog", "Admin", "PosSession", "PosLoginRequest" CASCADE');
  const owner = await db.admin.create({ data: { email: 'owner@example.test', passwordHash: 'unused', name: 'Owner' } });
  ownerToken = jwt.sign({ adminId: owner.id, email: owner.email, role: 'OWNER', tokenVersion: 0 }, process.env.JWT_SECRET!, { issuer: 'gem-crystal-api', audience: 'gem-crystal-admin' });
});
async function variant(id = 'a', stock = 2) {
  const product = await db.product.create({ data: { title: id, slug: id, gender: 'women', category: 'dress', subcategory: '', price: 100 } });
  return db.variant.create({ data: { id, productId: product.id, sku: id, size: 'M', color: 'black', price: 100, stockQuantity: stock } });
}
async function session(ref: string, ids = ['a'], overrides: any = {}) {
  return db.checkoutSession.create({ data: {
    sessionRef: ref, trackingTokenHash: hash(trackingToken + ref), customerName: 'Test Buyer', customerPhone: '+254712345678',
    customerCounty: 'Nairobi', customerTownCity: 'Nairobi', customerAddress: 'Test address',
    itemsJson: JSON.stringify(ids.map(variantId => ({ variantId, title: variantId, quantity: 1, price: 100 }))),
    subtotal: ids.length * 100, total: ids.length * 100, deliveryFee: 0,
    expiresAt: new Date(Date.now() + 60_000), ...overrides,
  } });
}
function payload(ref: string, receipt = 'RECEIPT1', amount = '100.00') {
  return { TransactionType: 'Buy Goods', TransID: receipt, TransTime: '20260916120000', TransAmount: amount,
    BusinessShortCode: '600000', BillRefNumber: ref, MSISDN: '254712345678', FirstName: 'Test' };
}
async function post(path: string, body: any, token?: string) {
  return fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
}

test('concurrent duplicate callback creates exactly one order and deducts stock once', async () => {
  await variant(); await session('CHECK1');
  await Promise.all(Array.from({ length: 4 }, () => processC2BPayment(db, payload('CHECK1'))));
  assert.equal(await db.order.count(), 1);
  assert.equal((await db.variant.findUnique({ where: { id: 'a' } })).stockQuantity, 1);
  assert.equal(await db.paymentNotification.count(), 1);
  assert.equal(await db.unmatchedPayment.count(), 0);
});

test('second item stock failure rolls back first item and records payment for review', async () => {
  await variant('a', 2); await variant('b', 0); await session('CHECK1', ['a', 'b']);
  await processC2BPayment(db, payload('CHECK1', 'RECEIPT1', '200.00'));
  assert.equal((await db.variant.findUnique({ where: { id: 'a' } })).stockQuantity, 2);
  assert.equal(await db.inventoryMovement.count(), 0);
  assert.equal(await db.order.count(), 0);
  assert.equal(await db.unmatchedPayment.count(), 1);
  assert.equal((await db.checkoutSession.findUnique({ where: { sessionRef: 'CHECK1' } })).status, 'FAILED');
});

test('competing paid checkouts for the final unit never oversell', async () => {
  await variant('a', 1); await session('CHECK1'); await session('CHECK2');
  await Promise.all([processC2BPayment(db, payload('CHECK1', 'R1')), processC2BPayment(db, payload('CHECK2', 'R2'))]);
  assert.equal(await db.order.count(), 1);
  assert.equal(await db.unmatchedPayment.count(), 1);
  assert.equal((await db.variant.findUnique({ where: { id: 'a' } })).stockQuantity, 0);
});

test('replayed receipt cannot pay a different checkout', async () => {
  await variant(); await session('CHECK1'); await session('CHECK2');
  await processC2BPayment(db, payload('CHECK1'));
  await processC2BPayment(db, payload('CHECK2'));
  assert.equal((await db.checkoutSession.findUnique({ where: { sessionRef: 'CHECK2' } })).status, 'AWAITING_PAYMENT');
});

test('coupon usage cap is atomic and unsuccessful settlement restores stock', async () => {
  await variant('a', 3);
  await db.coupon.create({ data: { code: 'ONE', discountType: 'FIXED', discountValue: 10, expiryDate: '2099-01-01', usageLimit: 1 } });
  await session('CHECK1', ['a'], { couponCode: 'ONE', discount: 10, total: 90 });
  await session('CHECK2', ['a'], { couponCode: 'ONE', discount: 10, total: 90 });
  await Promise.all([processC2BPayment(db, payload('CHECK1', 'R1', '90.00')), processC2BPayment(db, payload('CHECK2', 'R2', '90.00'))]);
  assert.equal(await db.order.count(), 1);
  assert.equal((await db.coupon.findUnique({ where: { code: 'ONE' } })).usageCount, 1);
  assert.equal((await db.variant.findUnique({ where: { id: 'a' } })).stockQuantity, 2);
});

test('missing reference and wrong amount stay unmatched, never guessed', async () => {
  await variant(); await session('CHECK1');
  await processC2BPayment(db, payload(''));
  await processC2BPayment(db, payload('CHECK1', 'R2', '100.01'));
  assert.equal(await db.order.count(), 0);
  assert.equal(await db.unmatchedPayment.count(), 2);
});

test('reference-free Till payment can be reviewed, assigned, and delivered to the POS', async () => {
  await variant('a', 2);
  const { token, sale } = await posFixture('PENDING');
  await processC2BPayment(db, payload('', 'TILLRECEIPT1'));

  const listResponse = await fetch(`${base}/orders/unmatched-payments`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(listResponse.status, 200);
  const list: any = await listResponse.json();
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].mpesaReceipt, 'TILLRECEIPT1');

  const assignment = await post(`/orders/unmatched-payments/${list.data[0].id}/resolve`, {
    action: 'ASSIGNED',
    note: 'Verified sandbox Till payment',
    targetType: 'POS_SALE',
    targetRef: sale.receiptNumber,
  }, ownerToken);
  assert.equal(assignment.status, 200);

  const notificationResponse = await fetch(`${base}/pos/payment-notifications`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(notificationResponse.status, 200);
  const notification: any = await notificationResponse.json();
  assert.equal(notification.notifications.length, 1);
  assert.equal(notification.notifications[0].orderNumber, sale.receiptNumber);
  assert.equal(notification.notifications[0].mpesaReceipt, 'TILLRECEIPT1');
});

test('owner can reconcile a verified payment to an expired website checkout exactly once', async () => {
  await variant(); await session('CHECK1', ['a'], { expiresAt: new Date(0) });
  await processC2BPayment(db, payload('CHECK1'));
  const payment = await db.unmatchedPayment.findFirst();
  const body = { action: 'ASSIGNED', note: 'Verified payer and reference', targetType: 'CHECKOUT_SESSION', targetRef: 'CHECK1' };
  const responses = await Promise.all([post(`/orders/unmatched-payments/${payment.id}/resolve`, body, ownerToken), post(`/orders/unmatched-payments/${payment.id}/resolve`, body, ownerToken)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 400]);
  assert.equal(await db.order.count(), 1);
});

test('tracking requires the private token and returns the authoritative numeric order', async () => {
  await variant(); await session('CHECK1');
  assert.equal((await fetch(base + '/orders/checkout-session/CHECK1')).status, 401);
  assert.equal((await fetch(base + '/orders/checkout-session/CHECK1', { headers: { 'X-Order-Tracking-Token': 'wrong' } })).status, 404);
  await processC2BPayment(db, payload('CHECK1'));
  const response = await fetch(base + '/orders/checkout-session/CHECK1', { headers: { 'X-Order-Tracking-Token': trackingToken + 'CHECK1' } });
  const result: any = await response.json();
  assert.equal(result.status, 'PAID'); assert.equal(result.order.total, 100);
  assert.equal(result.order.trackingTokenHash, undefined);
});

test('polling expires overdue checkout without changing stock', async () => {
  await variant(); await session('CHECK1', ['a'], { expiresAt: new Date(0) });
  const response = await fetch(base + '/orders/checkout-session/CHECK1', { headers: { 'X-Order-Tracking-Token': trackingToken + 'CHECK1' } });
  assert.equal((await response.json() as any).status, 'EXPIRED');
  assert.equal((await db.variant.findUnique({ where: { id: 'a' } })).stockQuantity, 2);
});

test('webhook rejects wrong merchant and signals a transient database failure for retry', async () => {
  await variant(); await session('CHECK1');
  await post('/orders/c2b-callback?token=test-callback-secret', { ...payload('CHECK1'), BusinessShortCode: 'wrong' });
  assert.equal(await db.order.count(), 0);
  const original = db.$transaction;
  db.$transaction = async () => { throw new Error('Simulated database outage'); };
  try { assert.equal((await post('/orders/c2b-callback?token=test-callback-secret', payload('CHECK1'))).status, 503); }
  finally { db.$transaction = original; }
});

async function posFixture(status = 'PAID') {
  const token = 'test-pos-session-token';
  await db.posSession.create({ data: { requestId: 'request1', cashierId: 'cashier1', cashierName: 'Cashier', approvedBy: 'Owner', sessionTokenHash: hash(token), expiresAt: new Date(Date.now() + 60_000) } });
  const sale = await db.posSale.create({ data: {
    receiptNumber: 'POS1', checkoutIdempotencyKey: 'fixture-key', cashierId: 'cashier1', cashierName: 'Cashier', items: JSON.stringify([{ variantId: 'a', title: 'a', size: 'M', color: 'black', quantity: 1 }]),
    subtotal: 100, total: 100, paymentMethod: 'MPESA', paymentStatus: status,
    mpesaReceipt: status === 'PAID' ? 'POSRECEIPT' : null, paymentExpiresAt: new Date(Date.now() + 60_000),
  } });
  return { token, sale };
}

test('POS reconnect and duplicate completion deduct once, acknowledgement follows completion', async () => {
  await variant('a', 2);
  const { token, sale } = await posFixture();
  const notice = await db.paymentNotification.create({ data: { posSaleId: sale.id, paymentReference: sale.receiptNumber, customerName: 'Test', customerPhone: '', amount: 100, mpesaReceipt: 'POSRECEIPT' } });
  const early = await post(`/pos/payment-notifications/${notice.id}/acknowledge`, {}, token);
  assert.equal((await early.json() as any).acknowledged, false);
  const completions = await Promise.all([post(`/pos/sales/${sale.id}/complete`, {}, token), post(`/pos/sales/${sale.id}/complete`, {}, token)]);
  assert.deepEqual(completions.map(r => r.status), [200, 200]);
  assert.equal((await db.variant.findUnique({ where: { id: 'a' } })).stockQuantity, 1);
  const ack = await post(`/pos/payment-notifications/${notice.id}/acknowledge`, {}, token);
  assert.equal((await ack.json() as any).acknowledged, true);
  assert.equal((await post(`/pos/sales/${sale.id}/complete`, {}, token)).status, 200);
  assert.equal((await db.variant.findUnique({ where: { id: 'a' } })).stockQuantity, 1);
});

test('Daraja confirmation reaches only the creating cashier and stays queued until completion', async () => {
  await variant('a', 2);
  const { token, sale } = await posFixture('PENDING');
  const body = { ...payload(sale.receiptNumber), MSISDN: '2547 * 126' };
  assert.equal((await post('/orders/c2b-callback?token=test-callback-secret', body)).status, 200);
  assert.equal((await post('/orders/c2b-callback?token=test-callback-secret', body)).status, 200);
  assert.equal(await db.paymentNotification.count(), 1);
  assert.equal(await db.salePayment.count(), 1);
  const poll = async (sessionToken: string) => (await fetch(`${base}/pos/payment-notifications`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  })).json() as Promise<any>;
  const alerts = (await poll(token)).notifications;
  assert.equal(alerts[0].orderNumber, sale.receiptNumber);
  assert.equal(alerts[0].mpesaReceipt, body.TransID);
  assert.equal((await db.variant.findUnique({ where: { id: 'a' } })).stockQuantity, 2);
  await db.posSession.create({ data: { requestId: 'other-request', cashierId: 'cashier2', cashierName: 'Other',
    approvedBy: 'Owner', sessionTokenHash: hash('other-token'), expiresAt: new Date(Date.now() + 60_000) } });
  assert.equal((await poll('other-token')).notifications.length, 0);
  assert.equal((await poll(token)).notifications.length, 1);
  assert.equal((await post(`/pos/sales/${sale.id}/complete`, {}, token)).status, 200);
  await post(`/pos/payment-notifications/${alerts[0].id}/acknowledge`, {}, token);
  assert.equal((await poll(token)).notifications.length, 0);
  assert.equal((await db.variant.findUnique({ where: { id: 'a' } })).stockQuantity, 1);
});

test('unpaid POS sale cannot complete or change inventory', async () => {
  await variant(); const { token, sale } = await posFixture('PENDING');
  assert.equal((await post(`/pos/sales/${sale.id}/complete`, {}, token)).status, 400);
  assert.equal((await db.variant.findUnique({ where: { id: 'a' } })).stockQuantity, 2);
});

test('concurrent expiry workers restore a legacy order reservation exactly once', async () => {
  await variant('a', 1);
  await db.order.create({ data: {
    orderNumber: 'LEGACY1', trackingTokenHash: hash('legacy'), customerName: 'Test', customerPhone: '+254712345678',
    customerCounty: 'Nairobi', customerTownCity: 'Nairobi', customerAddress: 'Address',
    items: JSON.stringify([{ variantId: 'a', title: 'a', quantity: 1 }]), subtotal: 100, total: 100,
    paymentMethod: 'MPESA', paymentStatus: 'PENDING', paymentExpiresAt: new Date(0),
  } });
  const responses = await Promise.all([post('/pos/expire-pending', {}, ownerToken), post('/pos/expire-pending', {}, ownerToken)]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  assert.equal((await db.variant.findUnique({ where: { id: 'a' } })).stockQuantity, 2);
  assert.equal(await db.inventoryMovement.count(), 1);
});

test('owner cannot bypass verified payment with overrides, receipt edits or fulfillment', async () => {
  const order = await db.order.create({ data: {
    orderNumber: 'UNPAID1', trackingTokenHash: hash('unpaid'), customerName: 'Test', customerPhone: '+254712345678',
    customerCounty: 'Nairobi', customerTownCity: 'Nairobi', customerAddress: 'Address', items: '[]',
    subtotal: 100, total: 100, paymentMethod: 'MPESA', paymentStatus: 'PENDING',
  } });
  assert.equal((await post(`/orders/${order.id}/payment-override`, { paymentStatus: 'PAID', reason: 'Unverified receipt' }, ownerToken)).status, 400);
  for (const body of [{ mpesaReceipt: 'UNVERIFIED' }, { fulfillmentStatus: 'SHIPPED' }]) {
    const response = await fetch(`${base}/orders/${order.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` }, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
  }
  assert.equal((await db.order.findUnique({ where: { id: order.id } })).paymentStatus, 'PENDING');
});
