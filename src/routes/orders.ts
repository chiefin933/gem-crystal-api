import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiError } from '../lib/ApiError';
import { requireAdmin, requireRole, AuthRequest } from '../middleware/auth';
import { queueOrderPaymentNotification, queuePosSalePaymentNotification } from '../services/paymentNotifications';
import { eventBus } from '../events/EventBus';
import { releaseFailedOrderReservation } from './orderHelpers';
import {
  callbackSecretMatches,
  classifyMpesaInitiationError,
  initiateMpesaStkPush,
  isMpesaConfigured,
  normalizeMpesaPhone,
} from '../services/mpesa';
import {
  c2bSecretMatches,
  C2BPayload,
  getTillNumber,
  isC2BConfigured,
  normalizeC2BPhone,
  registerC2BUrls,
} from '../services/mpesaC2B';

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
  // mpesaPhone is optional — C2B Till payments don't require the customer's phone.
  // If provided it is used for order correlation and customer record.
  mpesaPhone: z.string().trim().regex(/^\+?[0-9]{9,15}$/, 'Enter a valid M-PESA phone number').optional(),
}).strict();

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

// releaseFailedPosSaleReservation is kept local since it's only used in the M-PESA callback here
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
// Public: create a CheckoutSession — NO order, NO stock deduction yet.
// Prices and availability are validated but stock is only deducted after
// Safaricom confirms payment inside the C2B callback transaction.
// This satisfies the payment-first invariant: if Safaricom has not confirmed,
// no order exists and no stock is touched.
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
    if ([...quantities.values()].some(q => q > 20)) {
      throw ApiError.badRequest('A maximum of 20 units is allowed per product variant');
    }

    if (data.paymentMethod === 'CARD') {
      throw new ApiError(503, 'PAYMENT_FAILED', 'Card payments are not yet available. Please pay via M-PESA.');
    }

    const normalizedCustomerPhone = normalizeMpesaPhone(data.customer.phone);
    if (!normalizedCustomerPhone) {
      throw ApiError.badRequest('Invalid customer phone number', 'BAD_REQUEST');
    }

    // ── Validate availability + calculate totals (read-only, no stock touch) ──
    const variants = await prisma.variant.findMany({
      where: { id: { in: [...quantities.keys()] }, product: { isActive: true } },
      include: { product: { select: { id: true, title: true, images: true, isActive: true } } },
    });
    if (variants.length !== quantities.size) {
      throw ApiError.badRequest('One or more selected products are no longer available');
    }

    const variantsById = new Map(variants.map(v => [v.id, v]));
    const lineItems = [...quantities.entries()].map(([variantId, quantity]) => {
      const v = variantsById.get(variantId)!;
      if (!v.product.isActive) throw ApiError.badRequest('One or more selected products are no longer available');
      // Availability check — warn customer now rather than after payment
      if (v.stockQuantity < quantity) {
        throw ApiError.outOfStock(`${v.product.title} (${v.size}/${v.color}) — only ${v.stockQuantity} left`);
      }
      return {
        productId: v.productId, variantId: v.id, title: v.product.title,
        size: v.size, color: v.color,
        price: toNum(v.salePrice ?? v.price),
        quantity,
        image: JSON.parse(v.product.images || '[]')[0] || '',
      };
    });

    const subtotal = roundMoney(lineItems.reduce((s, i) => s + i.price * i.quantity, 0));
    let couponCode: string | null = null;
    let discount = 0;

    const storeSettings = await prisma.storeSettings.findUnique({ where: { id: 'default' } });
    const DELIVERY_FEE_KES        = storeSettings?.deliveryFeeKes          ?? 350;
    const FREE_DELIVERY_THRESHOLD = storeSettings?.freeDeliveryThresholdKes ?? 10000;

    if (data.couponCode) {
      const coupon = await prisma.coupon.findUnique({ where: { code: data.couponCode } });
      if (!coupon || !coupon.isActive || new Date(coupon.expiryDate) < new Date() || coupon.usageCount >= coupon.usageLimit) {
        throw ApiError.badRequest('This promo code is not available');
      }
      if (subtotal < toNum(coupon.minOrderAmount)) {
        throw ApiError.badRequest(`Minimum order KES ${toNum(coupon.minOrderAmount).toLocaleString()} required`);
      }
      couponCode = coupon.code;
      discount = roundMoney(Math.min(
        coupon.discountType === 'PERCENTAGE' ? (subtotal * toNum(coupon.discountValue)) / 100 : toNum(coupon.discountValue),
        subtotal,
      ));
    }

    const deliveryFee = subtotal >= FREE_DELIVERY_THRESHOLD ? 0 : DELIVERY_FEE_KES;
    const total = roundMoney(subtotal - discount + deliveryFee);

    // ── Create CheckoutSession — payment intent with no stock side-effects ──
    const sessionRef = `GC-PAY-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const expiresAt  = new Date(Date.now() + 30 * 60 * 1000); // 30-min window

    const session = await (prisma as any).checkoutSession.create({
      data: {
        sessionRef,
        customerName:     data.customer.fullName,
        customerEmail:    data.customer.email || '',
        customerPhone:    normalizedCustomerPhone,
        customerCounty:   data.customer.county,
        customerTownCity: data.customer.townCity,
        customerAddress:  data.customer.address,
        customerNotes:    data.customer.notes,
        itemsJson:        JSON.stringify(lineItems),
        subtotal,
        discount,
        couponCode,
        deliveryFee,
        total,
        currency:       'KES',
        paymentMethod:  data.paymentMethod,
        status:         'AWAITING_PAYMENT',
        expiresAt,
      },
    });

    // Return session reference and Till instructions — no order number yet
    const tillNumber = getTillNumber();
    res.status(201).json({
      sessionRef: session.sessionRef,
      total,
      deliveryFee,
      discount,
      couponCode,
      expiresAt,
      tillNumber,
      status: 'AWAITING_PAYMENT',
      message: tillNumber
        ? `Pay KES ${total.toLocaleString()} to Till ${tillNumber} using reference ${sessionRef}. Your order will be confirmed automatically.`
        : 'Till number not configured. Contact the shop via WhatsApp.',
    });
  } catch (error) {
    next(error);
  }
});

// ── GET /api/orders/checkout-session/:ref ─────────────────────────────────
// Public: poll checkout session status. Returns AWAITING_PAYMENT, PAID,
// EXPIRED, or FAILED. The storefront polls this after showing the Till
// payment instructions, then redirects to order confirmation when PAID.
router.get('/checkout-session/:ref', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await (prisma as any).checkoutSession.findUnique({
      where: { sessionRef: req.params.ref },
      select: {
        sessionRef: true, status: true, total: true, expiresAt: true,
        orderId: true, couponCode: true,
      },
    });
    if (!session) throw ApiError.notFound('Checkout session not found');

    // If payment has been confirmed, include the order number for redirect
    let orderNumber: string | null = null;
    if (session.orderId) {
      const order = await prisma.order.findUnique({
        where: { id: session.orderId },
        select: { orderNumber: true, trackingTokenHash: true },
      });
      orderNumber = order?.orderNumber ?? null;
    }

    res.json({
      sessionRef: session.sessionRef,
      status: session.status,
      total: toNum(session.total),
      expiresAt: session.expiresAt,
      orderNumber,
    });
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
        await queueOrderPaymentNotification(tx, { ...paid, paymentReference: paid.orderNumber, actualPaymentAmount: paidAmount });
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
router.get('/', requireAdmin, requireRole('OWNER'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page  = Math.max(1, parseInt(String(req.query.page  ?? 1), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? 50), 10)));
    const skip  = (page - 1) * limit;

    const [orders, total] = await Promise.all([
      prisma.order.findMany({ orderBy: { createdAt: 'desc' }, skip, take: limit }),
      prisma.order.count(),
    ]);

    res.json({
      data: orders.map(serialiseOrder),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
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
//
// Enforced state machine — only these transitions are permitted:
//   PENDING             → PAID, FAILED
//   PENDING_CORRELATION → PAID, FAILED
//   PAID                → (no manual transitions — payment is final)
//   FAILED              → (no direct PAID — stock was already restored;
//                          re-buying requires a fresh order)
//
// Blocking FAILED → PAID prevents a ghost sale where stock was restored
// but the system records the order as paid without re-deducting inventory.
router.post('/:id/payment-override', requireAdmin, requireRole('OWNER'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = PaymentOverrideSchema.safeParse(req.body);
    if (!parsed.success) {
      throw ApiError.badRequest('Validation failed', 'BAD_REQUEST', parsed.error.flatten());
    }

    const { paymentStatus: targetStatus, reason } = parsed.data;
    const actor = req.adminEmail || req.adminId || 'OWNER';

    const order = await prisma.$transaction(async (tx) => {
      const existing = await tx.order.findUnique({ where: { id: req.params.id } });
      if (!existing) throw ApiError.notFound('Order not found');

      // Enforce allowed transition matrix
      const from = existing.paymentStatus;
      const ALLOWED: Record<string, string[]> = {
        'PENDING':             ['PAID', 'FAILED'],
        'PENDING_CORRELATION': ['PAID', 'FAILED'],
        'PAID':                [],
        'FAILED':              [],
      };

      const allowedTargets = ALLOWED[from] ?? [];
      if (!allowedTargets.includes(targetStatus)) {
        throw ApiError.badRequest(
          `Cannot transition payment from ${from} to ${targetStatus}. ` +
          (allowedTargets.length
            ? `Allowed: ${allowedTargets.join(', ')}.`
            : `${from} orders cannot be manually overridden.`),
          'BAD_REQUEST',
        );
      }

      const updated = await tx.order.update({
        where: { id: req.params.id },
        data: { paymentStatus: targetStatus },
      });

      // Restore stock when manually marking FAILED — consistent with
      // the automatic M-PESA failure path
      if (targetStatus === 'FAILED') {
        await releaseFailedOrderReservation(tx, existing, `Manual payment override to FAILED: ${reason}`);
      }

      await tx.auditLog.create({
        data: {
          actor,
          action: 'PAYMENT_STATUS_OVERRIDDEN',
          details: JSON.stringify({
            orderNumber: existing.orderNumber,
            from,
            to: targetStatus,
            reason,
          }),
          ipAddress: req.ip,
        },
      });

      return updated;
    });

    // Notify cashier if manually marking PAID (e.g. cash payment recorded after the fact)
    if (targetStatus === 'PAID') {
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

// ── GET /api/orders/unmatched-payments ────────────────────────────────────
// Owner: list unmatched C2B Till payments requiring manual review.
router.get('/unmatched-payments', requireAdmin, requireRole('OWNER'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page  = Math.max(1, parseInt(String(req.query.page  ?? 1), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? 50), 10)));
    const skip  = (page - 1) * limit;

    const [payments, total] = await Promise.all([
      (prisma as any).unmatchedPayment.findMany({
        where: { status: 'UNMATCHED' },
        orderBy: { receivedAt: 'desc' },
        skip,
        take: limit,
      }),
      (prisma as any).unmatchedPayment.count({ where: { status: 'UNMATCHED' } }),
    ]);

    res.json({
      data: payments,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
});

// ── POST /api/orders/unmatched-payments/:id/resolve ───────────────────────
// Owner: mark an unmatched payment as IGNORED or manually ASSIGN to order/sale.
router.post('/unmatched-payments/:id/resolve', requireAdmin, requireRole('OWNER'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { action, note, targetType, targetRef } = req.body as {
      action: 'ASSIGNED' | 'IGNORED';
      note: string;
      targetType?: 'ORDER' | 'POS_SALE';
      targetRef?: string;
    };

    if (!['ASSIGNED', 'IGNORED'].includes(action)) {
      throw ApiError.badRequest('action must be ASSIGNED or IGNORED');
    }
    if (!note?.trim()) {
      throw ApiError.badRequest('A resolution note is required');
    }

    const payment = await (prisma as any).unmatchedPayment.findUnique({ where: { id: req.params.id } });
    if (!payment) throw ApiError.notFound('Unmatched payment not found');
    if (payment.status !== 'UNMATCHED') {
      throw ApiError.badRequest(`Payment is already ${payment.status}`);
    }

    const actor = req.adminEmail || req.adminId || 'OWNER';

    await prisma.$transaction(async (tx) => {
      // If ASSIGNED, mark the target order/sale as PAID
      if (action === 'ASSIGNED' && targetType && targetRef) {
        if (targetType === 'ORDER') {
          await tx.order.updateMany({
            where: { orderNumber: targetRef, paymentStatus: { in: ['PENDING', 'PENDING_CORRELATION'] } },
            data: { paymentStatus: 'PAID', mpesaReceipt: payment.mpesaReceipt },
          });
        } else {
          await (tx as any).posSale.updateMany({
            where: { receiptNumber: targetRef, paymentStatus: { in: ['PENDING', 'PENDING_CORRELATION'] } },
            data: { paymentStatus: 'PAID', mpesaReceipt: payment.mpesaReceipt },
          });
        }
      }

      await (tx as any).unmatchedPayment.update({
        where: { id: req.params.id },
        data: {
          status: action,
          resolvedAt: new Date(),
          resolvedBy: actor,
          resolutionNote: note.trim(),
        },
      });

      await tx.auditLog.create({
        data: {
          actor,
          action: 'UNMATCHED_PAYMENT_RESOLVED',
          details: JSON.stringify({
            mpesaReceipt: payment.mpesaReceipt,
            amount: payment.amount,
            resolution: action,
            note: note.trim(),
            targetType,
            targetRef,
          }),
          ipAddress: req.ip,
        },
      });
    });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// ── POST /api/orders/mpesa-c2b-register ───────────────────────────────────
// Owner only — registers our C2B callback URLs with Daraja.
// Run this once, or whenever the callback URL changes.
router.post('/mpesa-c2b-register', requireAdmin, requireRole('OWNER'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!isC2BConfigured()) {
      throw new ApiError(503, 'PAYMENT_FAILED', 'M-PESA C2B is not fully configured. Check MPESA_TILL_NUMBER and other M-PESA env vars.');
    }
    const result = await registerC2BUrls();
    await prisma.auditLog.create({
      data: {
        actor: req.adminEmail || req.adminId || 'OWNER',
        action: 'MPESA_C2B_REGISTERED',
        details: `C2B URLs registered with Daraja: ${JSON.stringify(result)}`,
        ipAddress: req.ip,
      },
    });
    res.json({ success: true, result });
  } catch (error) {
    next(error);
  }
});

// ── POST /api/orders/mpesa-c2b-callback ───────────────────────────────────
// Daraja sends this when a customer pays the Gem & Crystal Till.
// We attempt to match the payment to a pending order or POS sale.
// If no safe match is found, we create an UnmatchedPayment for owner review.
router.post('/mpesa-c2b-callback', async (req: Request, res: Response, next: NextFunction) => {
  // Always return 200 to Safaricom immediately — never let them retry on error
  const accept = () => res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  const reject = (reason: string) => {
    console.warn('[C2B] Rejected callback:', reason);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); // still 200 to prevent retries
  };

  try {
    const token = typeof req.query.token === 'string' ? req.query.token : undefined;
    if (!c2bSecretMatches(token)) return reject('Invalid callback secret');

    const payload = req.body as C2BPayload;
    if (!payload?.TransID || !payload?.TransAmount || !payload?.MSISDN) {
      return reject('Missing required callback fields');
    }

    const amount   = parseFloat(payload.TransAmount);
    const receipt  = payload.TransID.trim();
    const phone    = normalizeC2BPhone(payload.MSISDN);
    const ref      = (payload.BillRefNumber || '').trim().toUpperCase();
    const payerName = [payload.FirstName, payload.MiddleName, payload.LastName].filter(Boolean).join(' ') || null;

    if (!Number.isFinite(amount) || amount <= 0) return reject('Invalid amount');

    await prisma.$transaction(async (tx) => {
      // ── Attempt 1: match by BillRefNumber (receipt/order number) ──────────
        // Cashier tells customer: "Pay Till XXXXX, reference GC-POS-ABCDE"
        let matchedOrder: any = null;
        let matchedSale:  any = null;
        let matchedSession: any = null;

        if (ref) {
          // CheckoutSession reference (website C2B payment — payment-first)
          matchedSession = await tx.checkoutSession.findUnique({
            where: { sessionRef: ref, status: 'AWAITING_PAYMENT' },
          }).catch(() => null);

          if (!matchedSession) {
            // Existing POS sale reference — BillRefNumber only, no phone+amount fallback
            matchedSale = await (tx as any).posSale.findFirst({
              where: { receiptNumber: ref, paymentStatus: { in: ['PENDING', 'PENDING_CORRELATION'] } },
            });
          }
        }

        // ── No safe match: create UnmatchedPayment for owner review ───────────
        // We deliberately do NOT fall back to phone+amount matching — that
        // risks confirming the wrong transaction when two customers pay the
        // same amount. Owner manually assigns via the Unmatched Payments panel.
        if (!matchedOrder && !matchedSale && !matchedSession) {
        await (tx as any).unmatchedPayment.upsert({
          where: { mpesaReceipt: receipt },
          update: {},
          create: {
            mpesaReceipt: receipt,
            amount,
            phone,
            payerName,
            rawPayload: JSON.stringify(payload),
            status: 'UNMATCHED',
          },
        });
        await tx.auditLog.create({
          data: {
            actor: 'M-PESA C2B service',
            action: 'PAYMENT_REQUIRES_REVIEW',
            details: `C2B payment ${receipt} KES ${amount} from ${phone} could not be matched — queued for owner review`,
            ipAddress: req.ip,
          },
        });
        return;
      }

      // ── Match found: verify amount and mark paid ──────────────────────────
      const payment = (matchedSession || matchedOrder || matchedSale)!;
      const toNumC2B = (v: any) => (v && typeof v === 'object' ? v.toNumber() : Number(v));
      const expectedAmount = toNumC2B(payment.total);

      if (Math.abs(amount - expectedAmount) > 1) {
        await (tx as any).unmatchedPayment.upsert({
          where: { mpesaReceipt: receipt },
          update: {},
          create: { mpesaReceipt: receipt, amount, phone, payerName, rawPayload: JSON.stringify(payload), status: 'UNMATCHED' },
        });
        await tx.auditLog.create({
          data: { actor: 'M-PESA C2B service', action: 'PAYMENT_REQUIRES_REVIEW',
            details: `C2B amount mismatch for ref ${ref}: expected ${expectedAmount}, received ${amount}`, ipAddress: req.ip },
        });
        return;
      }

      // ── CheckoutSession path: create Order + deduct stock atomically ──────
      if (matchedSession) {
        const sess = matchedSession;
        const lineItems = JSON.parse(sess.itemsJson) as Array<{
          variantId: string; productId: string; title: string;
          size: string; color: string; price: number; quantity: number; image: string;
        }>;
        const orderNumber   = newOrderNumber();
        const trackingToken = crypto.randomBytes(32).toString('base64url');

        for (const item of lineItems) {
          const rows = await tx.$queryRaw<Array<{ stockQuantity: number }>>`
            UPDATE "Variant" SET "stockQuantity" = "stockQuantity" - ${item.quantity}
            WHERE "id" = ${item.variantId} AND "stockQuantity" >= ${item.quantity}
            RETURNING "stockQuantity"
          `;
          if (rows.length !== 1) {
            await (tx as any).unmatchedPayment.upsert({
              where: { mpesaReceipt: receipt },
              update: {},
              create: { mpesaReceipt: receipt, amount, phone, payerName, rawPayload: JSON.stringify(payload),
                status: 'UNMATCHED', resolutionNote: `Out of stock at confirmation: ${item.title} — refund required` },
            });
            return;
          }
          await tx.inventoryMovement.create({
            data: { variantId: item.variantId, type: 'SALE', quantity: -item.quantity,
              previousStock: rows[0].stockQuantity + item.quantity, newStock: rows[0].stockQuantity,
              reason: `C2B confirmed order #${orderNumber}`, referenceType: 'ECOM_ORDER',
              referenceId: orderNumber, actor: 'C2B payment service' },
          });
        }

        if (sess.couponCode) {
          await tx.coupon.updateMany({
            where: { code: sess.couponCode, isActive: true },
            data: { usageCount: { increment: 1 } },
          });
        }

        await tx.customer.upsert({
          where: { phone: sess.customerPhone },
          update: { name: sess.customerName, county: sess.customerCounty, city: sess.customerTownCity },
          create: { name: sess.customerName, phone: sess.customerPhone, email: sess.customerEmail || null, county: sess.customerCounty, city: sess.customerTownCity },
        });

        const order = await tx.order.create({
          data: {
            orderNumber, trackingTokenHash: hashTrackingToken(trackingToken),
            customerName: sess.customerName, customerEmail: sess.customerEmail || '',
            customerPhone: sess.customerPhone, customerCounty: sess.customerCounty,
            customerTownCity: sess.customerTownCity, customerAddress: sess.customerAddress,
            customerNotes: sess.customerNotes, items: sess.itemsJson,
            subtotal: sess.subtotal, discount: sess.discount, couponCode: sess.couponCode,
            deliveryFee: sess.deliveryFee, total: sess.total, currency: sess.currency,
            paymentMethod: 'MPESA', paymentStatus: 'PAID', fulfillmentStatus: 'PENDING',
            mpesaReceipt: receipt,
          },
        });

        await (tx as any).checkoutSession.update({
          where: { id: sess.id },
          data: { status: 'PAID', mpesaReceipt: receipt, orderId: order.id },
        });

        await queueOrderPaymentNotification(tx, { ...order, paymentReference: order.orderNumber, actualPaymentAmount: amount });
        await tx.auditLog.create({
          data: { actor: 'M-PESA C2B service', action: 'PAYMENT_CONFIRMED',
            details: `C2B ${receipt} KES ${amount}: session ${sess.sessionRef} confirmed. Order #${orderNumber} created, stock deducted.`, ipAddress: req.ip },
        });
        return;
      }

      // All checks passed — mark existing order/sale as PAID
      if (matchedOrder) {
        const paid = await tx.order.update({ where: { id: matchedOrder.id }, data: { paymentStatus: 'PAID', mpesaReceipt: receipt } });
        await queueOrderPaymentNotification(tx, { ...paid, paymentReference: paid.orderNumber });
      } else {
        const paid = await (tx as any).posSale.update({ where: { id: matchedSale.id }, data: { paymentStatus: 'PAID', mpesaReceipt: receipt } });
        await queuePosSalePaymentNotification(tx, { ...paid, paymentReference: paid.receiptNumber, currency: 'KES' });
      }

      await tx.auditLog.create({
        data: { actor: 'M-PESA C2B service', action: 'PAYMENT_CONFIRMED',
          details: `C2B payment ${receipt} KES ${amount} from ${phone} confirmed for ref ${ref}`, ipAddress: req.ip },
      });
    });

    return accept();
  } catch (error) {
    console.error('[C2B callback error]', error);
    return accept(); // always 200 to Safaricom
  }
});

// ── GET /api/orders/till-number ───────────────────────────────────────────
// Public: returns the configured Till number so the storefront and POS
// can display it to customers without embedding it in frontend code.
router.get('/till-number', (_req: Request, res: Response) => {
  const till = getTillNumber();
  res.json({ tillNumber: till ?? null, configured: !!till });
});

export default router;
