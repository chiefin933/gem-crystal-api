import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiError } from '../lib/ApiError';
import { requireAdmin, requireRole, AuthRequest } from '../middleware/auth';
import { queueOrderPaymentNotification, queuePosSalePaymentNotification } from '../services/paymentNotifications';
import { eventBus } from '../events/EventBus';
import {
  callbackSecretMatches,
  classifyMpesaInitiationError,
  initiateMpesaStkPush,
  isMpesaConfigured,
  normalizeMpesaPhone,
} from '../services/mpesa';

const router = Router();

/**
 * toNum — safely converts a Prisma Decimal (or plain number) to a JS number.
 * Prisma Decimal fields serialize as Decimal objects at runtime; they must be
 * converted before any JS arithmetic or comparison.
 */
function toNum(v: { toNumber(): number } | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'object' ? v.toNumber() : Number(v);
}

const CustomerSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254).optional().or(z.literal('')),
  phone: z.string().trim().regex(/^\+?[0-9]{9,15}$/, 'Enter a valid phone number'),
  county: z.string().trim().min(1).max(80),
  townCity: z.string().trim().min(1).max(100),
  address: z.string().trim().min(5).max(500),
  notes: z.string().trim().max(1000).optional().default(''),
}).strict();

const CheckoutSchema = z.object({
  customer: CustomerSchema,
  items: z.array(z.object({
    variantId: z.string().min(1).max(64),
    quantity: z.number().int().positive().max(20),
  }).strict()).min(1).max(25),
  couponCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,32}$/).optional(),
  // CARD is structurally accepted in the schema to preserve the type model,
  // but the route handler rejects it before any transaction until a gateway
  // is integrated. This keeps the frontend type valid while blocking fake payments.
  paymentMethod: z.enum(['MPESA', 'CARD']),
  mpesaPhone: z.string().trim().regex(/^\+?[0-9]{9,15}$/, 'Enter a valid M-PESA phone number').optional(),
}).strict().superRefine((data, ctx) => {
  if (data.paymentMethod === 'MPESA' && !data.mpesaPhone) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mpesaPhone'], message: 'An M-PESA phone number is required' });
  }
});

const OrderUpdateSchema = z.object({
  // Owners can freely update fulfillment status and attach an M-PESA receipt.
  // Payment status changes are handled by the dedicated override endpoint below
  // to ensure every financial state transition is audited with a reason.
  fulfillmentStatus: z.enum(['PENDING', 'PROCESSING', 'READY', 'SHIPPED', 'DELIVERED']).optional(),
  mpesaReceipt: z.string().trim().min(3).max(100).optional(),
}).strict().refine(
  value => value.fulfillmentStatus !== undefined || value.mpesaReceipt !== undefined,
  { message: 'Provide at least one order update' },
);

// Separate schema for the payment override endpoint — requires explicit reason
const PaymentOverrideSchema = z.object({
  paymentStatus: z.enum(['PAID', 'FAILED', 'PENDING']),
  reason: z.string().trim().min(3, 'Reason is required for payment status changes').max(500),
}).strict();

const MpesaCallbackSchema = z.object({
  Body: z.object({
    stkCallback: z.object({
      MerchantRequestID: z.string().min(1).max(200),
      CheckoutRequestID: z.string().min(1).max(200),
      ResultCode: z.number().int(),
      ResultDesc: z.string().max(500),
      CallbackMetadata: z.object({
        Item: z.array(z.object({
          Name: z.string().min(1).max(100),
          Value: z.union([z.string(), z.number(), z.null()]).optional(),
        }).strict()).max(20),
      }).optional(),
    }).strict(),
  }).strict(),
}).strict();

function hashTrackingToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function newOrderNumber(): string {
  return `GC-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function roundMoney(value: number): number {
  // Round to 2 decimal places using the "round half away from zero" rule.
  // toFixed(2) then back to number avoids floating-point drift.
  return Number(value.toFixed(2));
}

function serialiseOrder(order: any) {
  return {
    ...order,
    items: JSON.parse(order.items),
    customer: {
      fullName: order.customerName,
      email: order.customerEmail,
      phone: order.customerPhone,
      county: order.customerCounty,
      townCity: order.customerTownCity,
      address: order.customerAddress,
      notes: order.customerNotes,
    },
  };
}

function callbackValue(items: Array<{ Name: string; Value?: string | number | null }>, name: string): string | number | null {
  return items.find(item => item.Name === name)?.Value ?? null;
}

async function releaseFailedOrderReservation(tx: any, order: any, reason: string): Promise<void> {
  const items = JSON.parse(order.items) as Array<{ variantId: string; quantity: number; title: string }>;
  for (const item of items) {
    if (!item.variantId || !Number.isInteger(item.quantity) || item.quantity < 1) continue;
    const variant = await tx.variant.findUnique({ where: { id: item.variantId } });
    if (!variant) continue;
    const restored = await tx.variant.update({
      where: { id: item.variantId },
      data: { stockQuantity: { increment: item.quantity } },
      select: { stockQuantity: true },
    });
    await tx.inventoryMovement.create({
      data: {
        variantId: item.variantId,
        type: 'RETURN',
        quantity: item.quantity,
        previousStock: restored.stockQuantity - item.quantity,
        newStock: restored.stockQuantity,
        reason,
        referenceType: 'ECOM_ORDER',
        referenceId: order.orderNumber,
        actor: 'M-PESA payment service',
      },
    });
  }

  if (order.couponCode) {
    await tx.coupon.updateMany({
      where: { code: order.couponCode, usageCount: { gt: 0 } },
      data: { usageCount: { decrement: 1 } },
    });
  }
}

async function releaseFailedPosSaleReservation(tx: any, sale: any, reason: string): Promise<void> {
  const items = JSON.parse(sale.items) as Array<{ variantId: string; quantity: number }>;
  for (const item of items) {
    if (!item.variantId || !Number.isInteger(item.quantity) || item.quantity < 1) continue;
    const variant = await tx.variant.findUnique({ where: { id: item.variantId } });
    if (!variant) continue;
    const restored = await tx.variant.update({
      where: { id: item.variantId },
      data: { stockQuantity: { increment: item.quantity } },
      select: { stockQuantity: true },
    });
    await tx.inventoryMovement.create({
      data: {
        variantId: item.variantId,
        type: 'RETURN',
        quantity: item.quantity,
        previousStock: restored.stockQuantity - item.quantity,
        newStock: restored.stockQuantity,
        reason,
        referenceType: 'POS_SALE',
        referenceId: sale.receiptNumber,
        actor: 'M-PESA payment service',
      },
    });
  }
}

// ── POST /api/orders ──────────────────────────────────────────────────────
// Public: create an unpaid order. Prices, stock, discounts, and totals are
// always recalculated from database values; browser-supplied money is ignored.
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = CheckoutSchema.safeParse(req.body);
    if (!parsed.success) {
      throw ApiError.badRequest('Validation failed', 'BAD_REQUEST', parsed.error.flatten());
    }

    const data = parsed.data;
    const quantities = new Map<string, number>();
    for (const item of data.items) {
      quantities.set(item.variantId, (quantities.get(item.variantId) || 0) + item.quantity);
    }
    if ([...quantities.values()].some(quantity => quantity > 20)) {
      throw ApiError.badRequest('A maximum of 20 units is allowed per product variant');
    }

    const orderNumber = newOrderNumber();
    const trackingToken = crypto.randomBytes(32).toString('base64url');

    // ── Pre-transaction gates ─────────────────────────────────────────────
    // Reject before touching the database so no stock is deducted.

    if (data.paymentMethod === 'CARD') {
      throw new ApiError(503, 'PAYMENT_FAILED',
        'Card payments are not yet available. Please pay via M-PESA.',
      );
    }

    if (data.paymentMethod === 'MPESA' && !isMpesaConfigured()) {
      throw new ApiError(503, 'PAYMENT_FAILED',
        'M-PESA payments are temporarily unavailable. Please try again later.',
      );
    }

    // Normalize customer phone to E.164 so all records (Order, Customer,
    // M-PESA correlation) use a consistent format regardless of input style.
    const normalizedCustomerPhone = normalizeMpesaPhone(data.customer.phone);
    if (!normalizedCustomerPhone) {
      throw ApiError.badRequest('Invalid customer phone number', 'BAD_REQUEST');
    }

    const order = await prisma.$transaction(async tx => {
      const variants = await tx.variant.findMany({
        where: {
          id: { in: [...quantities.keys()] },
          product: { isActive: true },
        },
        include: {
          product: {
            select: { id: true, title: true, images: true, isActive: true },
          },
        },
      });

      if (variants.length !== quantities.size) {
        throw ApiError.badRequest('One or more selected products are no longer available');
      }

      const variantsById = new Map(variants.map(variant => [variant.id, variant]));
      const lineItems = [...quantities.entries()].map(([variantId, quantity]) => {
        const variant = variantsById.get(variantId);
        if (!variant || !variant.product.isActive) {
          throw ApiError.badRequest('One or more selected products are no longer available');
        }
        const price = toNum(variant.salePrice ?? variant.price);
        return {
          productId: variant.productId,
          variantId: variant.id,
          title: variant.product.title,
          size: variant.size,
          color: variant.color,
          price,
          quantity,
          image: JSON.parse(variant.product.images || '[]')[0] || '',
        };
      });

      const subtotal = roundMoney(lineItems.reduce((sum, item) => sum + item.price * item.quantity, 0));
      let couponCode: string | null = null;
      let discount = 0;

      if (data.couponCode) {
        const coupon = await tx.coupon.findUnique({ where: { code: data.couponCode } });
        const expired = !coupon || new Date(coupon.expiryDate) < new Date();
        if (!coupon || !coupon.isActive || expired || coupon.usageCount >= coupon.usageLimit) {
          throw ApiError.badRequest('This promo code is not available');
        }
        if (subtotal < toNum(coupon.minOrderAmount)) {
          throw ApiError.badRequest(`This promo code requires a minimum order of KES ${toNum(coupon.minOrderAmount).toLocaleString()}`);
        }
        couponCode = coupon.code;
        discount = roundMoney(Math.min(
          coupon.discountType === 'PERCENTAGE'
            ? (subtotal * toNum(coupon.discountValue)) / 100
            : toNum(coupon.discountValue),
          subtotal,
        ));
      }

      const deliveryFee = subtotal >= 10000 ? 0 : 350;
      const total = roundMoney(subtotal - discount + deliveryFee);

      // The conditional update is the stock authority. It prevents two
      // simultaneous checkouts from both selling the same final unit.
      for (const item of lineItems) {
        const rows = await tx.$queryRaw<Array<{ stockQuantity: number }>>`
          UPDATE "Variant"
          SET "stockQuantity" = "stockQuantity" - ${item.quantity}
          WHERE "id" = ${item.variantId}
            AND "stockQuantity" >= ${item.quantity}
          RETURNING "stockQuantity"
        `;
        if (rows.length !== 1) {
          throw ApiError.outOfStock(`${item.title} (${item.size} / ${item.color}) no longer has enough stock`);
        }

        await tx.inventoryMovement.create({
          data: {
            variantId: item.variantId,
            type: 'SALE',
            quantity: -item.quantity,
            previousStock: rows[0].stockQuantity + item.quantity,
            newStock: rows[0].stockQuantity,
            reason: `E-commerce order #${orderNumber}`,
            referenceType: 'ECOM_ORDER',
            referenceId: orderNumber,
            actor: 'Storefront customer',
          },
        });
      }

      if (couponCode) {
        const coupon = await tx.coupon.findUniqueOrThrow({
          where: { code: couponCode },
          select: { usageLimit: true },
        });
        const claim = await tx.coupon.updateMany({
          where: {
            code: couponCode,
            isActive: true,
            usageCount: { lt: coupon.usageLimit },
          },
          data: { usageCount: { increment: 1 } },
        });
        if (claim.count !== 1) {
          throw ApiError.badRequest('This promo code is no longer available');
        }
      }

      await tx.customer.upsert({
        where: { phone: normalizedCustomerPhone },
        update: {
          name: data.customer.fullName,
          email: data.customer.email || null,
          county: data.customer.county,
          city: data.customer.townCity,
        },
        create: {
          name: data.customer.fullName,
          phone: normalizedCustomerPhone,
          email: data.customer.email || null,
          county: data.customer.county,
          city: data.customer.townCity,
        },
      });

      return tx.order.create({
        data: {
          orderNumber,
          trackingTokenHash: hashTrackingToken(trackingToken),
          customerName: data.customer.fullName,
          customerEmail: data.customer.email || '',
          customerPhone: normalizedCustomerPhone,
          customerCounty: data.customer.county,
          customerTownCity: data.customer.townCity,
          customerAddress: data.customer.address,
          customerNotes: data.customer.notes,
          items: JSON.stringify(lineItems),
          subtotal,
          discount,
          couponCode,
          deliveryFee,
          total,
          currency: 'KES',
          paymentMethod: data.paymentMethod,
          paymentStatus: 'PENDING',
          fulfillmentStatus: 'PENDING',
          mpesaPhone: data.paymentMethod === 'MPESA' ? data.mpesaPhone || null : null,
          mpesaReceipt: null,
        },
      });
    });

    // Emit OrderCreated after the transaction commits — never inside it.
    eventBus.emit('OrderCreated', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      total: toNum(order.total),
      paymentMethod: order.paymentMethod,
    });

    let paymentInitiated = false;
    if (data.paymentMethod === 'MPESA' && data.mpesaPhone && isMpesaConfigured()) {
      // Normalize the M-PESA phone. Use mpesaPhone if provided (customer may
      // want a different number), otherwise fall back to normalizedCustomerPhone.
      const mpesaPayPhone = normalizeMpesaPhone(data.mpesaPhone) ?? normalizedCustomerPhone;
      // Generate a unique idempotency key and persist it BEFORE calling
      // Safaricom. If the HTTP connection drops after Daraja accepts the
      // request but before we receive the response, the key lets us
      // correlate any callback that still arrives.
      const idempotencyKey = crypto.randomBytes(16).toString('hex');
      await prisma.order.update({
        where: { id: order.id },
        data: {
          mpesaIdempotencyKey: idempotencyKey,
          mpesaInitiatedAt: new Date(),
        },
      });

      try {
        const paymentRequest = await initiateMpesaStkPush({
          orderNumber: order.orderNumber,
          amount: toNum(order.total),
          phone: mpesaPayPhone,
        });
        const saved = await prisma.order.updateMany({
          where: { id: order.id, paymentStatus: 'PENDING', mpesaCheckoutRequestId: null },
          data: {
            mpesaCheckoutRequestId: paymentRequest.checkoutRequestId,
            mpesaMerchantRequestId: paymentRequest.merchantRequestId,
          },
        });
        paymentInitiated = saved.count === 1;
      } catch (error) {
        const errorClass = classifyMpesaInitiationError(error);
        console.error(`M-PESA STK initiation ${errorClass === 'TIMEOUT' ? 'timed out' : 'failed'} for ${order.orderNumber}:`, error instanceof Error ? error.message : error);

        if (errorClass === 'REJECTED') {
          // Safaricom definitively refused — safe to fail and restore immediately.
          await prisma.$transaction(async (tx) => {
            await tx.order.updateMany({
              where: { id: order.id, paymentStatus: 'PENDING' },
              data: { paymentStatus: 'FAILED' },
            });
            await releaseFailedOrderReservation(tx, order, `M-PESA STK rejected for order #${order.orderNumber}`);
            await tx.auditLog.create({
              data: {
                actor: 'Storefront checkout',
                action: 'PAYMENT_FAILED',
                details: `M-PESA STK rejected for order #${order.orderNumber}. Stock restored. Error: ${error instanceof Error ? error.message : 'unknown'}`,
                ipAddress: req.ip,
              },
            });
          });
          throw ApiError.badRequest(
            'M-PESA payment was rejected. Please try again or contact the shop.',
            'PAYMENT_FAILED',
          );
        }

        // TIMEOUT: ambiguous — leave PENDING for callback or reconciliation.
        await prisma.order.updateMany({
          where: { id: order.id, paymentStatus: 'PENDING' },
          data: { paymentStatus: 'PENDING_CORRELATION' },
        });
        await prisma.auditLog.create({
          data: {
            actor: 'Storefront checkout',
            action: 'PAYMENT_PENDING',
            details: `M-PESA STK timed out for order #${order.orderNumber}. Marked PENDING_CORRELATION — awaiting callback or reconciliation. idempotencyKey recorded.`,
            ipAddress: req.ip,
          },
        });
        // paymentInitiated stays false — storefront shows "waiting for M-PESA" state.
      }
    }

    // The bearer token is intentionally returned once, only to the customer
    // who created the order. It prevents order-number guessing from exposing PII.
    res.status(201).json({ ...serialiseOrder(order), trackingToken, paymentInitiated });
  } catch (error) {
    next(error);
  }
});

// ── GET /api/orders/:orderNumber ──────────────────────────────────────────
// Public customer tracking requires the one-time token returned at checkout.
router.get('/:orderNumber', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const trackingToken = req.header('X-Order-Tracking-Token');
    if (!trackingToken || trackingToken.length > 200) {
      throw ApiError.unauthorized('Order tracking token required');
    }

    const order = await prisma.order.findUnique({ where: { orderNumber: req.params.orderNumber } });
    if (
      !order ||
      !crypto.timingSafeEqual(
        Buffer.from(hashTrackingToken(trackingToken), 'hex'),
        Buffer.from(order.trackingTokenHash, 'hex'),
      )
    ) {
      throw ApiError.notFound('Order not found');
    }

    res.json(serialiseOrder(order));
  } catch (error) {
    next(error);
  }
});

// ── POST /api/orders/mpesa-callback ───────────────────────────────────────
// Daraja calls this after an STK Push. It is deliberately correlated to the
// exact CheckoutRequestID created by this server; a phone number or receipt
// alone can never make an order paid.
router.post('/mpesa-callback', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isMpesaConfigured()) {
      res.status(503).json({ ResultCode: 1, ResultDesc: 'M-PESA payment integration is not configured' });
      return;
    }

    const token = typeof req.query.token === 'string' ? req.query.token : undefined;
    if (!callbackSecretMatches(token)) {
      res.status(401).json({ ResultCode: 1, ResultDesc: 'Unauthorized callback' });
      return;
    }

    const parsed = MpesaCallbackSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ResultCode: 1, ResultDesc: 'Malformed M-PESA callback' });
      return;
    }

    const callback = parsed.data.Body.stkCallback;

    // Capture event payloads outside the transaction so they can be emitted
    // after commit. Never schedule events inside $transaction — a rollback
    // would already have fired them.
    let pendingEvent: (() => void) | null = null;

    const outcome = await prisma.$transaction(async tx => {
      const order = await tx.order.findUnique({ where: { mpesaCheckoutRequestId: callback.CheckoutRequestID } });
      const sale = order ? null : await tx.posSale.findUnique({ where: { mpesaCheckoutRequestId: callback.CheckoutRequestID } });
      const payment = order || sale;
      const reference = order?.orderNumber || sale?.receiptNumber;
      const expectedPhone = order?.mpesaPhone || sale?.customerPhone;

      if (!payment || payment.paymentMethod !== 'MPESA' || payment.mpesaMerchantRequestId !== callback.MerchantRequestID || !reference) {
        return { accepted: false, message: 'Payment request was not recognized' };
      }

      if (callback.ResultCode !== 0) {
        const failed = order
          ? await tx.order.updateMany({ where: { id: order.id, paymentStatus: { in: ['PENDING', 'PENDING_CORRELATION'] } }, data: { paymentStatus: 'FAILED' } })
          : await tx.posSale.updateMany({ where: { id: sale!.id, paymentStatus: { in: ['PENDING', 'PENDING_CORRELATION'] } }, data: { paymentStatus: 'FAILED' } });
        if (failed.count === 1) {
          if (order) await releaseFailedOrderReservation(tx, order, `M-PESA payment failed for order #${reference}`);
          else await releaseFailedPosSaleReservation(tx, sale, `M-PESA payment failed for POS receipt #${reference}`);
          await tx.auditLog.create({
            data: { actor: 'M-PESA payment service', action: 'PAYMENT_FAILED', details: `Payment #${reference}: ${callback.ResultDesc}`, ipAddress: req.ip },
          });
          // Capture event data — emit after transaction commits below
          const evtRef = reference!;
          const evtType = order ? 'ORDER' : 'POS_SALE';
          const evtReason = callback.ResultDesc;
          pendingEvent = () => eventBus.emit('PaymentFailed', { reference: evtRef, type: evtType as any, reason: evtReason });
        }
        return { accepted: true, message: 'Payment result received' };
      }

      const metadata = callback.CallbackMetadata?.Item || [];
      const receipt = callbackValue(metadata, 'MpesaReceiptNumber');
      const amount = callbackValue(metadata, 'Amount');
      const phone = callbackValue(metadata, 'PhoneNumber');
      const paidAmount = typeof amount === 'number' ? amount : Number(amount);
      const paidPhone = phone === null ? null : normalizeMpesaPhone(String(phone));
      const normalizedExpectedPhone = expectedPhone ? normalizeMpesaPhone(expectedPhone) : null;

      if (
        typeof receipt !== 'string' || receipt.trim().length < 3 || receipt.length > 100 ||
        !Number.isFinite(paidAmount) || Math.abs(paidAmount - toNum(payment.total)) > 0.01 ||
        !paidPhone || !normalizedExpectedPhone || paidPhone !== normalizedExpectedPhone
      ) {
        await tx.auditLog.create({
          data: { actor: 'M-PESA payment service', action: 'PAYMENT_REQUIRES_REVIEW', details: `Payment data mismatch for #${reference}; left pending for owner review`, ipAddress: req.ip },
        });
        return { accepted: false, message: 'Payment details require review' };
      }

      if (payment.paymentStatus === 'PAID') {
        return { accepted: payment.mpesaReceipt === receipt.trim(), message: payment.mpesaReceipt === receipt.trim() ? 'Payment was already recorded' : 'Conflicting receipt' };
      }
      if (!['PENDING', 'PENDING_CORRELATION'].includes(payment.paymentStatus)) return { accepted: false, message: 'Payment cannot be accepted' };

      if (order) {
        const paid = await tx.order.update({ where: { id: order.id }, data: { paymentStatus: 'PAID', mpesaReceipt: receipt.trim() } });
        await queueOrderPaymentNotification(tx, { ...paid, paymentReference: paid.orderNumber });
        // Capture event payload — emit AFTER transaction commits
        const evt = {
          orderId: paid.id, orderNumber: paid.orderNumber,
          customerName: paid.customerName, customerPhone: paid.customerPhone,
          customerAddress: paid.customerAddress, customerTownCity: paid.customerTownCity,
          customerCounty: paid.customerCounty, total: toNum(paid.total),
          paymentMethod: paid.paymentMethod, mpesaReceipt: paid.mpesaReceipt,
          items: JSON.parse(paid.items),
        };
        pendingEvent = () => eventBus.emit('OrderPaid', evt);
      } else {
        const paid = await tx.posSale.update({ where: { id: sale!.id }, data: { paymentStatus: 'PAID', mpesaReceipt: receipt.trim() } });
        await queuePosSalePaymentNotification(tx, { ...paid, paymentReference: paid.receiptNumber, currency: 'KES' });
        const evt = {
          receiptNumber: paid.receiptNumber, cashierName: paid.cashierName,
          customerName: paid.customerName, customerPhone: paid.customerPhone,
          total: toNum(paid.total), paymentMethod: paid.paymentMethod,
          mpesaReceipt: paid.mpesaReceipt, items: JSON.parse(paid.items),
        };
        pendingEvent = () => eventBus.emit('SaleCreated', evt);
      }
      await tx.auditLog.create({
        data: { actor: 'M-PESA payment service', action: 'PAYMENT_CONFIRMED', details: `Payment #${reference} confirmed via M-PESA receipt ${receipt.trim()}`, ipAddress: req.ip },
      });
      return { accepted: true, message: 'Payment confirmed' };
    });

    // Emit domain events AFTER the transaction has committed.
    // Using setImmediate here is safe because we are outside $transaction.
    if (pendingEvent) setImmediate(pendingEvent);

    res.json({ ResultCode: outcome.accepted ? 0 : 1, ResultDesc: outcome.message });
  } catch (error) {
    next(error);
  }
});

// ── GET /api/orders ───────────────────────────────────────────────────────
router.get('/', requireAdmin, requireRole('OWNER'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const orders = await prisma.order.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(orders.map(serialiseOrder));
  } catch (error) {
    next(error);
  }
});

// ── PUT /api/orders/:id ───────────────────────────────────────────────────
// Admin: update fulfillment status and/or attach an M-PESA receipt.
// Payment status changes must go through POST /api/orders/:id/payment-override.
router.put('/:id', requireAdmin, requireRole('OWNER'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = OrderUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw ApiError.badRequest('Validation failed', 'BAD_REQUEST', parsed.error.flatten());
    }

    const existing = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!existing) throw ApiError.notFound('Order not found');

    const order = await prisma.order.update({
      where: { id: req.params.id },
      data: parsed.data,
    });

    await prisma.auditLog.create({
      data: {
        actor: req.adminEmail || req.adminId || 'OWNER',
        action: 'ORDER_STATUS_UPDATED',
        details: `Updated order #${order.orderNumber}: ${JSON.stringify(parsed.data)}`,
        ipAddress: req.ip,
      },
    });

    res.json(serialiseOrder(order));
  } catch (error) {
    next(error);
  }
});

// ── POST /api/orders/:id/payment-override ─────────────────────────────────
// Admin: manually override an order's payment status.
// Every override requires an explicit reason and creates an AuditLog.
// FAILED override restores stock; PAID override queues the cashier notification.
router.post('/:id/payment-override', requireAdmin, requireRole('OWNER'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = PaymentOverrideSchema.safeParse(req.body);
    if (!parsed.success) {
      throw ApiError.badRequest('Validation failed', 'BAD_REQUEST', parsed.error.flatten());
    }

    const { paymentStatus, reason } = parsed.data;
    const actor = req.adminEmail || req.adminId || 'OWNER';

    const order = await prisma.$transaction(async (tx) => {
      const existing = await tx.order.findUnique({ where: { id: req.params.id } });
      if (!existing) throw ApiError.notFound('Order not found');

      if (existing.paymentStatus === paymentStatus) {
        throw ApiError.badRequest(`Order is already in ${paymentStatus} state`);
      }

      const updated = await tx.order.update({
        where: { id: req.params.id },
        data: { paymentStatus },
      });

      // Restore stock when manually marking an order FAILED
      if (paymentStatus === 'FAILED' && existing.paymentStatus !== 'FAILED') {
        await releaseFailedOrderReservation(tx, existing, `Manual payment override: ${reason}`);
      }

      await tx.auditLog.create({
        data: {
          actor,
          action: 'PAYMENT_STATUS_OVERRIDDEN',
          details: JSON.stringify({
            orderNumber: existing.orderNumber,
            from: existing.paymentStatus,
            to: paymentStatus,
            reason,
          }),
          ipAddress: req.ip,
        },
      });

      return updated;
    });

    // Notify cashier if manually marking PAID (e.g. cash payment after the fact)
    if (paymentStatus === 'PAID') {
      await queueOrderPaymentNotification(prisma, {
        ...order,
        paymentReference: order.orderNumber,
      });
    }

    res.json({ success: true, data: serialiseOrder(order) });
  } catch (error) {
    next(error);
  }
});

export default router;
