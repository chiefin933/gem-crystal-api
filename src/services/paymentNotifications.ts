import { PrismaClient } from '@prisma/client';

type ConfirmedPayment = {
  id: string;
  paymentReference: string;
  customerName: string;
  customerPhone: string | null;
  total: number;
  currency: string;
  paymentMethod: string;
  mpesaReceipt?: string | null;
};

/**
 * Enqueue a single POS alert only after the payment state has been verified
 * and written by the backend. The unique order id makes provider callback
 * retries safe and prevents duplicate cashier pop-ups.
 */
export async function queueOrderPaymentNotification(db: PrismaClient | any, order: ConfirmedPayment): Promise<void> {
  if (order.paymentMethod !== 'MPESA') return;

  await db.paymentNotification.upsert({
    where: { orderId: order.id },
    update: {
      mpesaReceipt: order.mpesaReceipt || null,
      amount: order.total,
    },
    create: {
      orderId: order.id,
      paymentReference: order.paymentReference,
      customerName: order.customerName,
      customerPhone: order.customerPhone || '',
      amount: order.total,
      currency: order.currency,
      paymentMethod: order.paymentMethod,
      mpesaReceipt: order.mpesaReceipt || null,
    },
  });
}

export async function queuePosSalePaymentNotification(db: PrismaClient | any, sale: ConfirmedPayment): Promise<void> {
  if (sale.paymentMethod !== 'MPESA') return;

  await db.paymentNotification.upsert({
    where: { posSaleId: sale.id },
    update: { mpesaReceipt: sale.mpesaReceipt || null, amount: sale.total },
    create: {
      posSaleId: sale.id,
      paymentReference: sale.paymentReference,
      customerName: sale.customerName,
      customerPhone: sale.customerPhone || '',
      amount: sale.total,
      currency: sale.currency,
      paymentMethod: sale.paymentMethod,
      mpesaReceipt: sale.mpesaReceipt || null,
    },
  });
}
