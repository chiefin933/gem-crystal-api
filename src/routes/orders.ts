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
  registerC2BUrls,

} from '../services/mpesaC2B';

import { hasSameKesAmount, kesToCents } from '../services/money';
import { lockPayments, receiptRecorded, settleCheckoutSession, processC2BPayment } from '../services/paymentSettlement';

const router = Router();

const RouteParamSchema = z.string().trim().min(1).max(128);
function validRouteParam(value: unknown, name: string): string {
  const parsed = RouteParamSchema.safeParse(value);
  if (!parsed.success) throw ApiError.badRequest(`Invalid ${name}`);
  return parsed.data;
}
const UnmatchedPaymentResolutionSchema = z.object({
  action: z.enum(['ASSIGNED', 'IGNORED']),
  note: z.string().trim().min(3).max(500).refine(
    value => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value),
    'Resolution note contains unsupported control characters',
  ),
  targetType: z.enum(['ORDER', 'POS_SALE', 'CHECKOUT_SESSION']).optional(),
  targetRef: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict().superRefine((value, context) => {
  if (value.action === 'ASSIGNED' && (!value.targetType || !value.targetRef)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Assigned payments require a target type and reference' });
  }
  if (value.action === 'IGNORED' && (value.targetType || value.targetRef)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Ignored payments cannot include a target' });
  }
});

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

const RequestedDeliveryDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .transform(value => new Date(`${value}T12:00:00.000Z`))
  .refine(value => !Number.isNaN(value.getTime()) && value >= new Date(new Date().toISOString().slice(0, 10)), 'Delivery date cannot be in the past');

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
  requestedDeliveryDate: RequestedDeliveryDateSchema.optional(),
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
    trackingTokenHash: undefined, branchId: 'ONLINE',
    subtotal: toNum(order.subtotal), discount: toNum(order.discount),
    deliveryFee: toNum(order.deliveryFee), total: toNum(order.total),
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

// releaseFailedPosSaleReservation — no stock operation under payment-first POS architecture.
// Stock is only deducted at completeSaleAtomically(), never at checkout, so there
// is nothing to restore when a pending M-PESA sale fails or expires.
async function releaseFailedPosSaleReservation(_tx: any, _sale: any, _reason: string): Promise<void> {
  // Intentionally empty — no inventory side-effect
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

    if (!isC2BConfigured()) throw new ApiError(503, 'PAYMENT_FAILED', 'M-PESA payments are temporarily unavailable. Please contact the shop.');

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

    // Delivery is arranged and paid directly with the delivery person; it is never
    // collected by this checkout or included in the M-PESA product payment.
    const deliveryFee = 0;
    const total = roundMoney(subtotal - discount);

    // ── Create CheckoutSession — payment intent with no stock side-effects ──
    const sessionRef = `GC-PAY-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const expiresAt  = new Date(Date.now() + 30 * 60 * 1000); // 30-min window

    if (total <= 0) throw ApiError.badRequest('The payment total must be greater than zero');
    const trackingToken = crypto.randomBytes(32).toString('base64url');
    const session = await prisma.checkoutSession.create({
      data: {
        sessionRef,
        trackingTokenHash: hashTrackingToken(trackingToken),
        customerName:     data.customer.fullName,
        customerEmail:    data.customer.email || '',
        customerPhone:    normalizedCustomerPhone,
        customerCounty:   data.customer.county,
        customerTownCity: data.customer.townCity,
        customerAddress:  data.customer.address,
        customerNotes:    data.customer.notes,
        requestedDeliveryDate: data.requestedDeliveryDate,
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
      trackingToken,
      total,
      deliveryFee,
      discount,
      couponCode,
      expiresAt,
      tillNumber,
      status: 'AWAITING_PAYMENT',
      message: tillNumber
        ? `Pay KES ${total.toLocaleString()} to Till ${tillNumber} and keep checkout reference ${sessionRef} for the shop. Delivery is arranged and paid separately with the delivery person. The shop will verify and link your payment before confirming your order.`
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
    const ref = validRouteParam(req.params.ref, 'checkout reference');
    const token = req.header('X-Order-Tracking-Token');
    if (!token || token.length > 200) throw ApiError.unauthorized('Checkout tracking token required');
    const session = await prisma.checkoutSession.findUnique({ where: { sessionRef: ref } });
    if (!session || !session.trackingTokenHash || session.trackingTokenHash !== hashTrackingToken(token)) {
      throw ApiError.notFound('Checkout session not found');
    }
    if (session.status === 'AWAITING_PAYMENT' && session.expiresAt <= new Date()) {
      await prisma.checkoutSession.updateMany({
        where: { id: session.id, status: 'AWAITING_PAYMENT', expiresAt: { lte: new Date() } },
        data: { status: 'EXPIRED' },
      });
    }
    const current = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: session.id } });
    const order = current.orderId ? await prisma.order.findUnique({ where: { id: current.orderId } }) : null;
    res.set('Cache-Control', 'no-store').json({
      sessionRef: current.sessionRef, status: current.status, total: toNum(current.total),
      expiresAt: current.expiresAt, orderNumber: order?.orderNumber ?? null,
      mpesaReceipt: current.mpesaReceipt, order: order ? serialiseOrder(order) : null,
    });
  } catch (error) {
    next(error);
  }
});

// ── GET /api/orders/till-number ───────────────────────────────────────────
// Public: returns the configured Till number so the storefront and POS
// can display it. Must be BEFORE /:orderNumber to avoid the dynamic route
// catching 'till-number' as an order number.
router.get('/till-number', (_req: Request, res: Response) => {
  const till = getTillNumber();
  res.json({ tillNumber: till ?? null, configured: !!till });
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
        // rawPayload is retained for server-side audit but never returned to browsers.
        select: {
          id: true, receipt: true, amount: true, phone: true, payerName: true,
          receivedAt: true, status: true, resolutionNote: true,
          resolvedAt: true, resolvedBy: true,
        },
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

// Public customer tracking requires the one-time token returned at checkout.
// ── GET /api/orders/:orderNumber ──────────────────────────────────────────
// IMPORTANT: All static GET routes must appear ABOVE this dynamic route.
router.get('/:orderNumber', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const trackingToken = req.header('X-Order-Tracking-Token');
    if (!trackingToken || trackingToken.length > 200) {
      throw ApiError.unauthorized('Order tracking token required');
    }

    const orderNumber = validRouteParam(req.params.orderNumber, 'order number');
    const order = await prisma.order.findUnique({ where: { orderNumber } });
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
      await lockPayments(tx);
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
        !Number.isFinite(paidAmount) || !hasSameKesAmount(paidAmount, payment.total) ||
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

      if (await receiptRecorded(tx, receipt.trim())) return { accepted: false, message: 'Receipt already recorded' };
      const claimed = order
        ? await tx.order.updateMany({ where: { id: order.id, paymentStatus: { in: ['PENDING', 'PENDING_CORRELATION'] } }, data: { paymentStatus: 'PAID' } })
        : await tx.posSale.updateMany({ where: { id: sale!.id, saleStatus: 'OPEN', paymentStatus: { in: ['PENDING', 'PENDING_CORRELATION'] } }, data: { paymentStatus: 'PAID' } });
      if (claimed.count !== 1) return { accepted: false, message: 'Payment state changed; review required' };
      if (order) {
        const paid = await tx.order.update({ where: { id: order.id }, data: { paymentStatus: 'PAID', paidAt: new Date(), mpesaReceipt: receipt.trim() } });
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
    const id = validRouteParam(req.params.id, 'order id');
    if (!parsed.success) {
      throw ApiError.badRequest('Validation failed', 'BAD_REQUEST', parsed.error.flatten());
    }

    const existing = await prisma.order.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound('Order not found');

    if (parsed.data.mpesaReceipt && parsed.data.mpesaReceipt !== existing.mpesaReceipt) {
      throw ApiError.badRequest('Payment receipts must come from verified callbacks or Unmatched Payments reconciliation');
    }
    if (parsed.data.fulfillmentStatus && parsed.data.fulfillmentStatus !== 'PENDING' && existing.paymentStatus !== 'PAID') {
      throw ApiError.badRequest('Confirm payment before fulfilling this order');
    }
    const order = await prisma.order.update({
      where: { id, paymentStatus: existing.paymentStatus },
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
    const id = validRouteParam(req.params.id, 'order id');
    if (!parsed.success) {
      throw ApiError.badRequest('Validation failed', 'BAD_REQUEST', parsed.error.flatten());
    }

    const { paymentStatus: targetStatus, reason } = parsed.data;
    const actor = req.adminEmail || req.adminId || 'OWNER';

    const order = await prisma.$transaction(async (tx) => {
      await lockPayments(tx);
      const existing = await tx.order.findUnique({ where: { id } });
      if (!existing) throw ApiError.notFound('Order not found');

      // Enforce allowed transition matrix
      if (existing.paymentMethod === 'MPESA' && targetStatus === 'PAID') throw ApiError.badRequest('Use a verified callback or Unmatched Payments to confirm M-PESA payments');
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
        where: { id, paymentStatus: from },
        data: { paymentStatus: targetStatus, paidAt: targetStatus === 'PAID' ? new Date() : existing.paidAt },
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

      if (targetStatus === 'PAID') await queueOrderPaymentNotification(tx, { ...updated, paymentReference: updated.orderNumber });
      return updated;
    });

    res.json({ success: true, data: serialiseOrder(order) });
  } catch (error) {
    next(error);
  }
});

// ── POST /api/orders/unmatched-payments/:id/resolve ───────────────────────
// Owner: mark an unmatched payment as IGNORED or manually ASSIGN to order/sale.
router.post('/unmatched-payments/:id/resolve', requireAdmin, requireRole('OWNER'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = UnmatchedPaymentResolutionSchema.safeParse(req.body);
    if (!parsed.success) throw ApiError.badRequest('Invalid unmatched payment resolution');
    const { action, note, targetType, targetRef } = parsed.data;
    const paymentId = validRouteParam(req.params.id, 'payment identifier');

    const actor = req.adminEmail || req.adminId || 'OWNER';
    await prisma.$transaction(async (tx) => {
      await lockPayments(tx);
      const payment = await tx.unmatchedPayment.findUnique({ where: { id: paymentId } });
      if (!payment) throw ApiError.notFound('Unmatched payment not found');
      if (payment.status !== 'UNMATCHED') throw ApiError.badRequest(`Payment is already ${payment.status}`);
      const paidAmount = toNum(payment.amount);
      if (action === 'ASSIGNED') {
        if (targetType === 'CHECKOUT_SESSION') {
          const session = await tx.checkoutSession.findUnique({ where: { sessionRef: targetRef } });
          if (!session || !['AWAITING_PAYMENT', 'EXPIRED', 'FAILED'].includes(session.status)) throw ApiError.badRequest('Checkout is unavailable or already paid');
          if (!hasSameKesAmount(payment.amount, session.total)) throw ApiError.badRequest('Payment amount does not match checkout total');
          await settleCheckoutSession(tx, session, payment.mpesaReceipt, paidAmount, true);
        } else if (targetType === 'ORDER') {
          // Verify the order exists and is in a state that can be paid
          const order = await tx.order.findFirst({
            where: { orderNumber: targetRef, paymentStatus: { in: ['PENDING', 'PENDING_CORRELATION'] } },
          });
          if (!order) throw ApiError.badRequest(`Order ${targetRef} not found or already paid`);

          // Exact amount check
          if (!hasSameKesAmount(payment.amount, order.total)) {
            throw ApiError.badRequest(
              `Payment amount KES ${paidAmount} does not match order total KES ${toNum(order.total)}`
            );
          }

          await tx.order.update({
            where: { id: order.id, paymentStatus: { in: ['PENDING', 'PENDING_CORRELATION'] } },
            data: { paymentStatus: 'PAID', paidAt: new Date(), mpesaReceipt: payment.mpesaReceipt },
          });

          await queueOrderPaymentNotification(tx, {
            ...order, mpesaReceipt: payment.mpesaReceipt, paymentReference: order.orderNumber,
            actualPaymentAmount: paidAmount,
          } as any);

        } else {
          // POS sale — mark PAID and create SalePayment ledger entry
          // Cashier must still call /complete to deduct stock
          const sale = await (tx as any).posSale.findFirst({
            where: { receiptNumber: targetRef, saleStatus: 'OPEN', paymentStatus: { in: ['PENDING', 'PENDING_CORRELATION'] } },
          });
          if (!sale) throw ApiError.badRequest(`POS sale ${targetRef} not found or already paid`);

          if (!hasSameKesAmount(payment.amount, sale.total)) {
            throw ApiError.badRequest(
              `Payment amount KES ${paidAmount} does not match sale total KES ${toNum(sale.total)}`
            );
          }

          await (tx as any).posSale.update({
            where: { id: sale.id, saleStatus: 'OPEN', paymentStatus: { in: ['PENDING', 'PENDING_CORRELATION'] } },
            data: { paymentStatus: 'PAID', mpesaReceipt: payment.mpesaReceipt },
          });

          // Create SalePayment ledger entry
          const existing = await (tx as any).salePayment.findFirst({
            where: { posSaleId: sale.id, method: 'MPESA' },
          });
          if (!existing) {
            await (tx as any).salePayment.create({
              data: {
                posSaleId: sale.id, method: 'MPESA',
                amount: paidAmount, mpesaReceipt: payment.mpesaReceipt, status: 'CONFIRMED',
              },
            });
          }

          await queuePosSalePaymentNotification(tx, {
            ...sale, mpesaReceipt: payment.mpesaReceipt, paymentReference: sale.receiptNumber, currency: 'KES',
            actualPaymentAmount: paidAmount,
          } as any);
        }
      }

      await (tx as any).unmatchedPayment.update({
        where: { id: paymentId },
        data: { status: action, resolvedAt: new Date(), resolvedBy: actor, resolutionNote: note.trim() },
      });

      await tx.auditLog.create({
        data: {
          actor,
          action: 'UNMATCHED_PAYMENT_RESOLVED',
          details: JSON.stringify({
            mpesaReceipt: payment.mpesaReceipt, amount: paidAmount,
            resolution: action, note: note.trim(), targetType, targetRef,
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

// ── POST /api/orders/c2b-callback ─────────────────────────────────────────
// ── POST /api/orders/mpesa-c2b-callback ───────────────────────────────────
// Daraja sends this when a customer pays the Gem & Crystal Till.
// We attempt to match the payment to a pending order or POS sale.
// If no safe match is found, we create an UnmatchedPayment for owner review.
const C2BCallbackSchema = z.object({
  TransactionType: z.string().min(1).max(50),
  TransID: z.string().min(1).max(100),
  TransTime: z.string().min(1).max(20),
  TransAmount: z.string().regex(/^\d+(\.\d{1,2})?$/, 'TransAmount must be a valid decimal'),
  BusinessShortCode: z.string().min(1).max(20),
  // Daraja C2B callbacks have historically used BillRefNumber. Some Buy
  // Goods integrations use AccountReference instead, so accept either name
  // and normalize it below. The value is optional because a customer paying a
  // Till does not enter a sale reference.
  BillRefNumber: z.string().max(100).optional(),
  AccountReference: z.string().max(100).optional(),
  // C2B v1 sandbox callbacks may SHA-256 hash the MSISDN, while v2 can mask
  // it. Accept those provider formats without mistaking them for a dialable
  // customer phone number during settlement.
  MSISDN: z.string().trim().min(3).max(128)
    .regex(/^[A-Za-z0-9+*# _-]+$/, 'MSISDN contains unsupported characters'),
  FirstName: z.string().max(100).optional().default(''),
  MiddleName: z.string().max(100).optional().default(''),
  LastName: z.string().max(100).optional().default(''),
}).passthrough().transform(value => ({
  ...value,
  BillRefNumber: value.BillRefNumber?.trim() || value.AccountReference?.trim() || '',
})); // allow extra fields Safaricom may add

export function parseC2BCallback(payload: unknown) {
  return C2BCallbackSchema.safeParse(payload);
}

// Daraja calls ValidationURL before accepting a C2B payment. This endpoint is
// deliberately side-effect free; confirmation remains the only finalization path.
router.post('/c2b-callback/validation', (req: Request, res: Response) => {
  const token = typeof req.query.token === 'string' ? req.query.token : undefined;
  if (!c2bSecretMatches(token)) {
    res.locals.c2bOutcome = 'invalid_secret';
    console.warn('[C2B] Rejected validation callback: invalid callback secret');
    res.json({ ResultCode: 1, ResultDesc: 'Unauthorized validation callback' });
    return;
  }

  const parsed = parseC2BCallback(req.body);
  if (!parsed.success || kesToCents(parsed.data.TransAmount) === null || Number(parsed.data.TransAmount) <= 0 || Number(parsed.data.TransAmount) > 99999999.99 || parsed.data.BusinessShortCode !== process.env.MPESA_SHORTCODE?.trim()) {
    res.locals.c2bOutcome = 'invalid_payload';
    console.warn('[C2B] Rejected validation callback: malformed payload');
    res.json({ ResultCode: 1, ResultDesc: 'Invalid C2B payment payload' });
    return;
  }

  res.locals.c2bOutcome = 'validation_accepted';
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});
router.post('/c2b-callback', async (req: Request, res: Response, next: NextFunction) => {
  const accept = () => { res.locals.c2bOutcome = 'processed'; return res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); };
  const reject = (reason: string) => {
    res.locals.c2bOutcome = reason;
    console.warn('[C2B] Rejected callback:', reason);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); // 200 to prevent Daraja retries
  };

  try {
    const token = typeof req.query.token === 'string' ? req.query.token : undefined;
    if (!c2bSecretMatches(token)) return reject('Invalid callback secret');

    const parsed = parseC2BCallback(req.body);
    if (!parsed.success) {
      console.warn('[C2B] Invalid payload schema:', parsed.error.flatten());
      return reject('Malformed C2B callback payload');
    }

    const payload = parsed.data as C2BPayload;
    const amount   = parseFloat(payload.TransAmount);
    const receipt  = payload.TransID.trim();

    if (!Number.isFinite(amount) || amount <= 0 || amount > 99999999.99) return reject('Invalid amount');

    if (payload.BusinessShortCode !== process.env.MPESA_SHORTCODE?.trim()) return reject('Wrong business shortcode');
    if (!receipt || kesToCents(payload.TransAmount) === null) return reject('Invalid receipt or amount');
    await processC2BPayment(prisma, payload, req.ip);

    return accept();
  } catch (error) {
    res.locals.c2bOutcome = 'processing_failed';
    console.error('[C2B callback error]', error);
    res.status(503).json({ ResultCode: 1, ResultDesc: 'Payment processing unavailable; retry required' });
  }
});

export default router;
