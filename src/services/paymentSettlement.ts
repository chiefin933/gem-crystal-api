import crypto from 'crypto';
import { CheckoutSession, Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ApiError } from '../lib/ApiError';
import { C2BPayload, normalizeC2BPhone } from './mpesaC2B';
import { hasSameKesAmount } from './money';
import { queueOrderPaymentNotification, queuePosSalePaymentNotification } from './paymentNotifications';

type Tx = Prisma.TransactionClient;
// Serialize receipt ownership across the C2B, STK and owner-resolution paths.
// Transaction-scoped locks are released on both commit and rollback.
export async function lockPayments(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(713429, 1)`;
}

export async function receiptRecorded(tx: Tx, receipt: string): Promise<boolean> {
  for (const model of [tx.order, tx.posSale, tx.checkoutSession, tx.salePayment, tx.unmatchedPayment]) {
    if (await (model as any).findUnique({ where: { mpesaReceipt: receipt }, select: { id: true } })) return true;
  }
  return false;
}

const Items = z.array(z.object({
  variantId: z.string().min(1), title: z.string(), quantity: z.number().int().positive().max(20),
})).min(1).max(25);

/** All changes belong to the caller's transaction. Throwing must roll it back. */
export async function settleCheckoutSession(tx: Tx, session: CheckoutSession, receipt: string, amount: number, ownerRecovery = false) {
  const claimed = await tx.checkoutSession.updateMany({
    where: {
      id: session.id,
      status: { in: ownerRecovery ? ['AWAITING_PAYMENT', 'EXPIRED', 'FAILED'] : ['AWAITING_PAYMENT'] },
      ...(ownerRecovery ? {} : { expiresAt: { gt: new Date() } }),
    },
    data: { status: 'PAID' },
  });
  if (claimed.count !== 1) throw new ApiError(409, 'PAYMENT_FAILED', 'Checkout is no longer awaiting payment');
  const items = Items.parse(JSON.parse(session.itemsJson)).sort((a, b) => a.variantId.localeCompare(b.variantId));
  const orderNumber = `GC-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  for (const item of items) {
    const rows = await tx.$queryRaw<Array<{ stockQuantity: number }>>`
      UPDATE "Variant" SET "stockQuantity" = "stockQuantity" - ${item.quantity}
      WHERE "id" = ${item.variantId} AND "stockQuantity" >= ${item.quantity}
      RETURNING "stockQuantity"
    `;
    if (rows.length !== 1) throw ApiError.outOfStock(`${item.title} is unavailable; payment requires owner review`);
    await tx.inventoryMovement.create({ data: {
      variantId: item.variantId, type: 'SALE', quantity: -item.quantity,
      previousStock: rows[0].stockQuantity + item.quantity, newStock: rows[0].stockQuantity,
      reason: `Confirmed order #${orderNumber}`, referenceType: 'ECOM_ORDER', referenceId: orderNumber, actor: 'Payment service',
    } });
  }
  if (session.couponCode) {
    const claimedCoupon = await tx.$executeRaw`
      UPDATE "Coupon" SET "usageCount" = "usageCount" + 1
      WHERE "code" = ${session.couponCode} AND "usageCount" < "usageLimit" AND "isActive" = true
    `;
    if (claimedCoupon !== 1) throw new ApiError(409, 'PAYMENT_FAILED', 'Coupon is no longer available; payment requires owner review');
  }
  await tx.customer.upsert({
    where: { phone: session.customerPhone },
    update: { name: session.customerName, county: session.customerCounty, city: session.customerTownCity },
    create: { name: session.customerName, phone: session.customerPhone, email: session.customerEmail || null, county: session.customerCounty, city: session.customerTownCity },
  });
  const order = await tx.order.create({ data: {
    orderNumber, trackingTokenHash: session.trackingTokenHash ?? crypto.randomBytes(32).toString('hex'),
    customerName: session.customerName, customerEmail: session.customerEmail, customerPhone: session.customerPhone,
    customerCounty: session.customerCounty, customerTownCity: session.customerTownCity,
    customerAddress: session.customerAddress, customerNotes: session.customerNotes,
    items: session.itemsJson, subtotal: session.subtotal, discount: session.discount, couponCode: session.couponCode,
    deliveryFee: session.deliveryFee, total: session.total, currency: session.currency,
    orderedAt: session.createdAt, requestedDeliveryDate: session.requestedDeliveryDate,
    paymentMethod: 'MPESA', paymentStatus: 'PAID', paidAt: new Date(), fulfillmentStatus: 'PENDING', mpesaReceipt: receipt,
  } });
  await tx.checkoutSession.update({ where: { id: session.id }, data: { status: 'PAID', mpesaReceipt: receipt, orderId: order.id } });
  await queueOrderPaymentNotification(tx, { ...order, paymentReference: order.orderNumber, actualPaymentAmount: amount });
  return order;
}

export async function processC2BPayment(db: PrismaClient, payload: C2BPayload, ipAddress?: string) {
  const receipt = payload.TransID.trim();
  const amount = Number(payload.TransAmount);
  const ref = (payload.BillRefNumber || '').trim().toUpperCase();
  const phone = normalizeC2BPhone(payload.MSISDN);
  const payerName = [payload.FirstName, payload.MiddleName, payload.LastName].filter(Boolean).join(' ') || null;
  await db.$transaction(async tx => {
    await lockPayments(tx);
    if (await receiptRecorded(tx, receipt)) return;
    const review = async (reason: string) => {
      await tx.unmatchedPayment.create({ data: {
        mpesaReceipt: receipt, amount, phone, payerName, rawPayload: JSON.stringify(payload), resolutionNote: reason,
      } });
      await tx.auditLog.create({ data: { actor: 'M-PESA C2B service', action: 'PAYMENT_REQUIRES_REVIEW', details: `${receipt}: ${reason}`, ipAddress } });
    };
    const session = ref ? await tx.checkoutSession.findUnique({ where: { sessionRef: ref } }) : null;
    const sale = !session && ref ? await tx.posSale.findUnique({ where: { receiptNumber: ref } }) : null;
    // Amount alone cannot establish which customer paid, even if only one till is open.
    if (!session && !sale) { await review('No checkout reference matched. Verify the payer and assign in Unmatched Payments.'); return; }
    const target = session ?? sale!;
    if (!hasSameKesAmount(payload.TransAmount, target.total)) { await review('Payment amount does not match checkout total'); return; }
    if (session) {
      if (session.status !== 'AWAITING_PAYMENT' || session.expiresAt <= new Date()) {
        await review('Checkout is expired or closed; owner review required'); return;
      }
      // A business failure must undo EVERY stock/coupon write, while retaining
      // the received payment for reconciliation in the enclosing transaction.
      await tx.$executeRawUnsafe('SAVEPOINT checkout_settlement');
      try {
        await settleCheckoutSession(tx, session, receipt, amount);
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT checkout_settlement');
      } catch (error) {
        if (!(error instanceof ApiError) || !['OUT_OF_STOCK', 'PAYMENT_FAILED'].includes(error.code)) throw error;
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT checkout_settlement');
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT checkout_settlement');
        await tx.checkoutSession.updateMany({ where: { id: session.id, status: 'AWAITING_PAYMENT' }, data: { status: 'FAILED' } });
        await review(error.message);
        return;
      }
    } else {
      const claimed = await tx.posSale.updateMany({
        where: { id: sale!.id, paymentMethod: 'MPESA', saleStatus: 'OPEN', paymentStatus: { in: ['PENDING', 'PENDING_CORRELATION'] }, paymentExpiresAt: { gt: new Date() } },
        data: { paymentStatus: 'PAID', mpesaReceipt: receipt, customerName: payerName || sale!.customerName, customerPhone: phone },
      });
      if (claimed.count !== 1) { await review('Sale is expired or closed; owner review required'); return; }
      const paid = await tx.posSale.findUniqueOrThrow({ where: { id: sale!.id } });
      await tx.salePayment.create({ data: { posSaleId: paid.id, method: 'MPESA', amount, mpesaReceipt: receipt, status: 'CONFIRMED' } });
      await queuePosSalePaymentNotification(tx, { ...paid, paymentReference: paid.receiptNumber, currency: 'KES', actualPaymentAmount: amount });
    }
    await tx.auditLog.create({ data: { actor: 'M-PESA C2B service', action: 'PAYMENT_CONFIRMED', details: `${receipt}: confirmed for ${ref}`, ipAddress } });
  }, { maxWait: 10_000, timeout: 20_000 });
}
