import { PrismaClient } from '@prisma/client';

type ConfirmedPayment = {
  id: string;
  paymentReference: string;
  customerName: string;
  customerPhone: string | null;
  total: number | { toNumber(): number };
  // actualPaymentAmount: the specific M-PESA amount confirmed (not necessarily the sale total
  // once partial/mixed payments are supported). Falls back to total when not provided.
  actualPaymentAmount?: number | { toNumber(): number } | null;
  currency: string;
  paymentMethod: string;
  mpesaReceipt?: string | null;
};

/**
 * Enqueue a single POS alert only after the payment state has been verified
 * and written by the backend. The unique order id makes provider callback
 * retries safe and prevents duplicate cashier pop-ups.
 */
function toNum(v: { toNumber(): number } | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'object' ? v.toNumber() : Number(v);
}

export async function queueOrderPaymentNotification(db: PrismaClient | any, order: ConfirmedPayment): Promise<void> {
  if (order.paymentMethod !== 'MPESA') return;
  const notificationAmount = toNum(order.actualPaymentAmount ?? order.total);

  await db.paymentNotification.upsert({
    where: { orderId: order.id },
    update: { mpesaReceipt: order.mpesaReceipt || null, amount: notificationAmount },
    create: {
      orderId: order.id, paymentReference: order.paymentReference,
      customerName: order.customerName, customerPhone: order.customerPhone || '',
      amount: notificationAmount, currency: order.currency,
      paymentMethod: order.paymentMethod, mpesaReceipt: order.mpesaReceipt || null,
    },
  });
}

export async function queuePosSalePaymentNotification(db: PrismaClient | any, sale: ConfirmedPayment): Promise<void> {
  if (sale.paymentMethod !== 'MPESA') return;
  const notificationAmount = toNum(sale.actualPaymentAmount ?? sale.total);

  await db.paymentNotification.upsert({
    where: { posSaleId: sale.id },
    update: { mpesaReceipt: sale.mpesaReceipt || null, amount: notificationAmount },
    create: {
      posSaleId: sale.id, paymentReference: sale.paymentReference,
      customerName: sale.customerName, customerPhone: sale.customerPhone || '',
      amount: notificationAmount, currency: sale.currency,
      paymentMethod: sale.paymentMethod, mpesaReceipt: sale.mpesaReceipt || null,
    },
  });
}
