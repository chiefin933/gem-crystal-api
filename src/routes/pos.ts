import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiError } from '../lib/ApiError';
import { AuthRequest, requireAdmin, requireRole } from '../middleware/auth';
import { initiateMpesaStkPush, isMpesaConfigured, normalizeMpesaPhone } from '../services/mpesa';

const router = Router();
// Prisma Client is regenerated after the schema change. Keep this route compatible
// with an older generated client during the migration step.
const db = prisma as any;

// ── Shared stock restoration helper ───────────────────────────────────────
// Restores stock for all line items in a failed POS sale and records
// inventory movements. Called when M-PESA initiation definitively fails.
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
        actor: 'POS payment service',
      },
    });
  }
}

const REQUEST_TTL_MS = 2 * 60 * 1000;
const POS_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// ── PIN brute-force protection ─────────────────────────────────────────────
// A 4-digit PIN has only 10,000 combinations. Without rate limiting an
// attacker with network access to /auth-request could guess it quickly.
// 5 failed attempts / 5 min per IP triggers a 429; successful requests
// are NOT counted so a legitimate cashier is never locked out by a good login.
const pinLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'UNAUTHORIZED',
      message: 'Too many login attempts. Please wait 5 minutes before trying again.',
    },
  },
});

// ── POS auth request schema ────────────────────────────────────────────────
const PosAuthRequestSchema = z.object({
  cashierName: z.string().trim().min(2, 'Cashier name is required').max(120),
  pinCode:     z.string().trim().min(4, 'PIN must be at least 4 digits').max(12),
  deviceId:    z.string().trim().max(100).optional(),
  biometricId: z.string().trim().max(200).optional(),
}).strict();

function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sessionTokenForRequest(requestId: string): string {
  const secret = process.env.POS_SESSION_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error('POS_SESSION_SECRET or JWT_SECRET is required');
  return crypto.createHmac('sha256', secret).update(`pos-session:${requestId}`).digest('hex');
}

function getPosToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

async function requirePosSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = getPosToken(req);
  if (!token) {
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Active POS session required' },
    });
    return;
  }

  try {
    const session = await db.posSession.findFirst({
      where: {
        sessionTokenHash: hashSessionToken(token),
        status: 'ACTIVE',
        expiresAt: { gt: new Date() },
      },
    });

    if (!session) {
      res.status(401).json({
        success: false,
        error: { code: 'AUTH_EXPIRED', message: 'POS session is invalid or expired' },
      });
      return;
    }

    (req as AuthRequest).adminId = session.cashierId;
    (req as AuthRequest).adminRole = 'CASHIER';
    (req as AuthRequest).adminEmail = undefined;
    (req as any).posSession = session;
    next();
  } catch (error) {
    next(error);
  }
}

// ── GET /api/pos/payment-notifications ────────────────────────────────────
// Returns unacknowledged payment notifications to the POS terminal.
// Notifications are NOT marked acknowledged here — the POS must confirm
// successful receipt by calling POST /payment-notifications/:id/acknowledge.
// This prevents notifications from being silently lost if Wi-Fi drops
// between the backend responding and the POS displaying the alert.
router.get('/payment-notifications', requirePosSession, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const notifications = await db.paymentNotification.findMany({
      where: { acknowledgedAt: null },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });

    res.json({
      success: true,
      notifications: notifications.map((n: any) => ({
        id: n.id,
        orderNumber: n.paymentReference,
        customerName: n.customerName,
        customerPhone: n.customerPhone,
        amount: n.amount,
        currency: n.currency,
        paymentMethod: n.paymentMethod,
        mpesaReceipt: n.mpesaReceipt,
        confirmedAt: n.createdAt,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// ── POST /api/pos/payment-notifications/:id/acknowledge ────────────────────
// Called by the POS AFTER it has successfully displayed/processed a payment
// notification. Only then is it marked acknowledged so it won't be re-delivered.
// Using a separate acknowledgement step means a crashed or disconnected POS
// will receive the notification again on the next poll.
router.post('/payment-notifications/:id/acknowledge', requirePosSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await db.paymentNotification.updateMany({
      where: {
        id: req.params.id,
        acknowledgedAt: null, // idempotent — already-acked notifications are a no-op
      },
      data: { acknowledgedAt: new Date() },
    });

    res.json({
      success: true,
      acknowledged: result.count === 1,
    });
  } catch (error) {
    next(error);
  }
});

// ── GET /api/pos/hardware ──────────────────────────────────────────────────
router.get('/hardware', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let hw = await db.hardwareConfig.findUnique({ where: { id: 'pos-01' } });
    if (!hw) {
      hw = await db.hardwareConfig.create({
        data: {
          id: 'pos-01',
          tabletName: 'Gem & Crystal POS Tablet 01 (Roysambu)',
          tabletConnected: false,
          barcodeScanner: false,
          fingerprintReader: false,
          receiptPrinter: false,
          cashDrawer: false,
          status: 'IDLE',
        },
      });
    }
    res.json({ success: true, hardware: hw });
  } catch (error) {
    next(error);
  }
});

// ── POST /api/pos/auth-request ─────────────────────────────────────────────
router.post('/auth-request', pinLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = PosAuthRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      // Return a generic message — don't distinguish "missing field" from
      // "wrong format" to avoid leaking which cashier names exist.
      throw ApiError.badRequest('Invalid login credentials', 'INVALID_CREDENTIALS');
    }

    const { cashierName, pinCode, biometricId, deviceId } = parsed.data;
    const cashier = await db.admin.findFirst({
      where: { name: cashierName, role: 'CASHIER' },
      select: { id: true, name: true, pinCode: true },
    });

    if (!cashier) {
      throw ApiError.unauthorized('Invalid cashier credentials', 'INVALID_CREDENTIALS');
    }

    let validPin = false;
    try {
      validPin = await bcrypt.compare(pinCode.trim(), cashier.pinCode);
    } catch {
      validPin = false;
    }

    // Transitional migration for legacy plaintext PINs already in the database.
    if (!validPin && cashier.pinCode === pinCode.trim()) {
      const newHash = await bcrypt.hash(pinCode.trim(), 12);
      await db.admin.update({ where: { id: cashier.id }, data: { pinCode: newHash } });
      validPin = true;
    }

    if (!validPin) {
      throw ApiError.unauthorized('Invalid cashier credentials', 'INVALID_CREDENTIALS');
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + REQUEST_TTL_MS);

    // Expire stale requests for this cashier before creating a new one.
    await db.posLoginRequest.updateMany({
      where: { cashierId: cashier.id, status: 'PENDING', expiresAt: { lte: now } },
      data: { status: 'EXPIRED' },
    });

    const pollToken = crypto.randomBytes(32).toString('hex');

    const request = await db.posLoginRequest.create({
      data: {
        cashierId: cashier.id,
        cashierName: cashier.name,
        deviceId: deviceId?.trim() || 'Tablet POS 01',
        location: 'Gem & Crystal — Roysambu',
        biometricId: biometricId?.trim() || null,
        pollTokenHash: hashSessionToken(pollToken),
        expiresAt,
      },
    });

    await db.auditLog.create({
      data: {
        actor: cashier.name,
        action: 'POS_LOGIN_REQUESTED',
        details: `Requested remote login authorization on ${request.deviceId}`,
        ipAddress: req.ip,
      },
    });

    res.json({
      success: true,
      requestId: request.id,
      cashierName: request.cashierName,
      status: request.status,
      expiresAt: request.expiresAt,
      pollToken,
      message: 'Waiting for shop owner authorization...',
    });
  } catch (error) {
    next(error);
  }
});

// ── GET /api/pos/auth-status/:requestId ─────────────────────────────────────
router.get('/auth-status/:requestId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pollToken = req.header('X-POS-Poll-Token');
    if (!pollToken) {
      throw ApiError.unauthorized('POS polling token required', 'UNAUTHORIZED');
    }

    const request = await db.posLoginRequest.findUnique({
      where: { id: req.params.requestId },
      include: { cashier: { select: { name: true } } },
    });

    if (!request || !crypto.timingSafeEqual(
      Buffer.from(hashSessionToken(pollToken), 'hex'),
      Buffer.from(request.pollTokenHash, 'hex')
    )) {
      throw ApiError.unauthorized('Invalid POS polling credentials', 'UNAUTHORIZED');
    }

    if (request.status === 'PENDING' && request.expiresAt <= new Date()) {
      await db.posLoginRequest.update({
        where: { id: request.id },
        data: { status: 'EXPIRED' },
      });
      request.status = 'EXPIRED';
    }

    const session = request.status === 'APPROVED'
      ? await db.posSession.findUnique({ where: { requestId: request.id } })
      : null;

    res.json({
      success: true,
      requestId: request.id,
      cashierName: request.cashier.name,
      status: request.status,
      expiresAt: request.expiresAt,
      sessionToken: session?.status === 'ACTIVE' && session.expiresAt > new Date()
        ? (() => {
            // The plaintext POS session token is only delivered to the POS that
            // holds the one-time polling credential returned during login request.
            // It is never persisted in the database.
            return sessionTokenForRequest(request.id);
          })()
        : undefined,
      session: session ? {
        id: session.id,
        status: session.status,
        expiresAt: session.expiresAt,
      } : null,
    });
  } catch (error) {
    next(error);
  }
});

// ── POST /api/pos/logout ───────────────────────────────────────────────────
// Immediately ends the active POS session for the authenticated cashier.
// Using expiry alone means a stolen session token remains valid for up to
// 12 hours; an explicit logout closes the window immediately.
router.post('/logout', requirePosSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = (req as any).posSession as { id: string; cashierName: string };

    await db.$transaction(async (tx: any) => {
      await tx.posSession.updateMany({
        where: { id: session.id, status: 'ACTIVE' },
        data: { status: 'ENDED', endTime: new Date() },
      });
      await tx.auditLog.create({
        data: {
          actor: session.cashierName,
          action: 'POS_LOGOUT',
          details: `POS session ended by cashier ${session.cashierName}`,
          ipAddress: req.ip,
        },
      });
    });

    res.json({ success: true, message: 'POS session ended successfully.' });
  } catch (error) {
    next(error);
  }
});

// ── GET /api/pos/pending-approvals ─────────────────────────────────────────
router.get('/pending-approvals', requireAdmin, requireRole('OWNER'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const now = new Date();
    await db.posLoginRequest.updateMany({
      where: { status: 'PENDING', expiresAt: { lte: now } },
      data: { status: 'EXPIRED' },
    });

    const requests = await db.posLoginRequest.findMany({
      where: { status: 'PENDING', expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });

    res.json(requests.map((r: any) => ({
      id: r.id,
      cashierName: r.cashierName,
      deviceId: r.deviceId,
      location: r.location,
      biometricId: r.biometricId,
      timestamp: r.createdAt,
      expiresAt: r.expiresAt,
      status: r.status,
    })));
  } catch (error) {
    next(error);
  }
});

// ── POST /api/pos/approve-request ─────────────────────────────────────────
router.post('/approve-request', requireAdmin, requireRole('OWNER'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { requestId, action } = req.body as { requestId?: string; action?: 'APPROVE' | 'REJECT' };

    if (!requestId || !['APPROVE', 'REJECT'].includes(action || '')) {
      throw ApiError.badRequest('requestId and action (APPROVE or REJECT) are required');
    }

    const request = await db.posLoginRequest.findUnique({ where: { id: requestId } });
    if (!request) {
      throw ApiError.notFound('Authorization request not found or expired', 'AUTH_EXPIRED');
    }

    if (request.status !== 'PENDING' || request.expiresAt <= new Date()) {
      if (request.status === 'PENDING') {
        await db.posLoginRequest.update({ where: { id: request.id }, data: { status: 'EXPIRED' } });
      }
      throw ApiError.badRequest('Authorization request is no longer active', 'AUTH_EXPIRED');
    }

    if (action === 'REJECT') {
      await db.posLoginRequest.update({
        where: { id: request.id },
        data: { status: 'REJECTED' },
      });

      await db.auditLog.create({
        data: {
          actor: req.adminEmail || req.adminId || 'OWNER',
          action: 'POS_LOGIN_DENIED',
          details: `Denied POS access for ${request.cashierName} on ${request.deviceId}`,
          ipAddress: req.ip,
        },
      });

      res.json({ success: true, status: 'REJECTED' });
      return;
    }

    const sessionToken = sessionTokenForRequest(request.id);
    const sessionTokenHash = hashSessionToken(sessionToken);
    const expiresAt = new Date(Date.now() + POS_SESSION_TTL_MS);

    const result = await db.$transaction(async (tx: any) => {
      const claimed = await tx.posLoginRequest.updateMany({
        where: {
          id: request.id,
          status: 'PENDING',
          expiresAt: { gt: new Date() },
        },
        data: { status: 'APPROVED' },
      });

      if (claimed.count !== 1) {
        throw ApiError.badRequest('Authorization request is no longer active', 'AUTH_EXPIRED');
      }

      // Only one active POS session per cashier.
      await tx.posSession.updateMany({
        where: { cashierId: request.cashierId, status: 'ACTIVE' },
        data: { status: 'ENDED', endTime: new Date() },
      });

      const session = await tx.posSession.create({
        data: {
          requestId: request.id,
          cashierId: request.cashierId,
          cashierName: request.cashierName,
          approvedBy: req.adminEmail || req.adminId || 'OWNER',
          sessionTokenHash,
          status: 'ACTIVE',
          expiresAt,
        },
      });

      await tx.auditLog.create({
        data: {
          actor: req.adminEmail || req.adminId || 'OWNER',
          action: 'POS_LOGIN_APPROVED',
          details: `Approved POS access for ${request.cashierName} on ${request.deviceId}`,
          ipAddress: req.ip,
        },
      });

      return session;
    });

    res.json({
      success: true,
      status: 'APPROVED',
      session: {
        id: result.id,
        cashierId: result.cashierId,
        cashierName: result.cashierName,
        expiresAt: result.expiresAt,
      },
      sessionToken,
    });
  } catch (error) {
    next(error);
  }
});

// ── POST /api/pos/checkout ─────────────────────────────────────────────────
router.post('/checkout', requirePosSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = (req as any).posSession as { cashierId: string; cashierName: string };
    const {
      customerName,
      customerPhone,
      mpesaReceipt,
      items,
      discountPercent,
      paymentMethod,
      cashReceived,
      changeGiven,
      offlineReceiptId,
    } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      throw ApiError.badRequest('Cart cannot be empty for POS checkout', 'BAD_REQUEST');
    }

    const quantities = new Map<string, number>();
    for (const item of items) {
      if (typeof item?.variantId !== 'string') throw ApiError.badRequest('Each cart item requires a variant');
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
        throw ApiError.badRequest('Each cart quantity must be between 1 and 20');
      }
      quantities.set(item.variantId, (quantities.get(item.variantId) || 0) + quantity);
    }
    if ([...quantities.values()].some(quantity => quantity > 20)) {
      throw ApiError.badRequest('A maximum of 20 units is allowed per variant');
    }

    const variants = await db.variant.findMany({
      where: { id: { in: [...quantities.keys()] }, product: { isActive: true } },
      include: { product: { select: { id: true, title: true, images: true, isActive: true } } },
    });
    if (variants.length !== quantities.size) throw ApiError.badRequest('One or more items are no longer available');

    const variantsById = new Map<string, any>(variants.map((variant: any) => [variant.id, variant]));
    const lineItems = [...quantities.entries()].map(([variantId, quantity]) => {
      const variant = variantsById.get(variantId);
      if (!variant || !variant.product.isActive) throw ApiError.badRequest('One or more items are no longer available');
      return {
        variantId: variant.id,
        productId: variant.productId,
        title: variant.product.title,
        sku: variant.sku,
        size: variant.size,
        color: variant.color,
        price: variant.salePrice ?? variant.price,
        quantity,
        image: JSON.parse(variant.product.images || '[]')[0] || '',
      };
    });
    const serverSubtotal = Number(lineItems.reduce((sum: number, item: any) => sum + item.price * item.quantity, 0).toFixed(2));
    const safeDiscountPercent = Number(discountPercent) || 0;
    if (!Number.isInteger(safeDiscountPercent) || safeDiscountPercent < 0 || safeDiscountPercent > 20) {
      throw ApiError.badRequest('POS discount must be a whole number from 0 to 20');
    }
    const serverDiscount = Number((serverSubtotal * safeDiscountPercent / 100).toFixed(2));
    const serverTotal = Number((serverSubtotal - serverDiscount).toFixed(2));
    const finalPaymentMethod = paymentMethod as string;
    if (!['CASH', 'MPESA'].includes(finalPaymentMethod)) {
      // CARD is not yet integrated with a real card processor/terminal.
      // Accepting it would record a PAID sale without authorization evidence.
      // Reject all unknown payment methods rather than silently defaulting.
      throw ApiError.badRequest(
        finalPaymentMethod === 'CARD'
          ? 'Card payment is not yet available on this terminal. Please use Cash or M-PESA.'
          : 'Invalid payment method. Accepted: CASH, MPESA',
        'BAD_REQUEST',
      );
    }
    if (finalPaymentMethod === 'CASH' && Number(cashReceived) < serverTotal) {
      throw ApiError.badRequest('Cash received is less than the sale total');
    }

    const receiptNumber = offlineReceiptId || ('GC-POS-' + Date.now().toString().slice(-6));
    const finalCustomerName = customerName || 'Walk-in Customer';
    const normalizedPhone = customerPhone ? normalizeMpesaPhone(String(customerPhone)) : null;
    if (finalPaymentMethod === 'MPESA' && (!normalizedPhone || !isMpesaConfigured())) {
      throw ApiError.badRequest(
        !normalizedPhone ? 'A valid customer M-PESA phone number is required' : 'M-PESA is not configured',
      );
    }

    const existingSale = await db.posSale.findUnique({ where: { receiptNumber } });
    if (existingSale) {
      res.status(200).json({
        success: true,
        receiptNumber: existingSale.receiptNumber,
        sale: { ...existingSale, items: JSON.parse(existingSale.items) },
        idempotent: true,
        signals: { cashDrawerKickout: false, receiptPrinterTrigger: false },
      });
      return;
    }

    const sale = await db.$transaction(async (tx: any) => {
      for (const item of lineItems) {
        const variant = variantsById.get(item.variantId);
        if (!variant) throw ApiError.notFound(`Product variant ${item.variantId} was not found`);

        // Atomic stock deduction: the database itself enforces stock >= requested quantity.
        const updated = await tx.$executeRaw`
          UPDATE "Variant"
          SET "stockQuantity" = "stockQuantity" - ${item.quantity}
          WHERE "id" = ${item.variantId}
            AND "stockQuantity" >= ${item.quantity}
        `;

        if (updated !== 1) {
          throw ApiError.outOfStock(
            `Item "${item.title}" (${item.size}/${item.color}) is out of stock or has insufficient stock`
          );
        }

        await tx.inventoryMovement.create({
          data: {
            variantId: item.variantId,
            type: 'SALE',
            quantity: -item.quantity,
            previousStock: variant.stockQuantity,
            newStock: variant.stockQuantity - item.quantity,
            reason: `POS Sale Receipt #${receiptNumber}`,
            referenceType: 'POS_SALE',
            referenceId: receiptNumber,
            actor: session.cashierName,
          },
        });
      }

      const createdSale = await tx.posSale.create({
        data: {
          receiptNumber,
          cashierName: session.cashierName,
          customerName: finalCustomerName,
          customerPhone: customerPhone || null,
          mpesaReceipt: finalPaymentMethod === 'MPESA' ? null : (mpesaReceipt || null),
          items: JSON.stringify(lineItems),
          subtotal: serverSubtotal,
          discount: serverDiscount,
          total: serverTotal,
          paymentMethod: finalPaymentMethod,
          paymentStatus: finalPaymentMethod === 'MPESA' ? 'PENDING' : 'PAID',
          cashReceived: finalPaymentMethod === 'CASH' ? Number(cashReceived) : null,
          changeGiven: finalPaymentMethod === 'CASH' ? Math.max(0, Number(cashReceived) - serverTotal) : null,
        },
      });

      if (customerPhone) {
        // Use the normalized phone so +254712345678, 0712345678, and
        // 254712345678 all resolve to the same customer record.
        const persistPhone = normalizedPhone || customerPhone;
        await tx.customer.upsert({
          where: { phone: persistPhone },
          update: { name: finalCustomerName },
          create: { name: finalCustomerName, phone: persistPhone },
        });
      }

      await tx.auditLog.create({
        data: {
          actor: session.cashierName,
          action: 'SALE_CREATED',
          details: `Receipt #${receiptNumber} created for ${finalCustomerName}. Total: KES ${serverTotal} via ${finalPaymentMethod}${finalPaymentMethod === 'MPESA' ? ' (awaiting M-PESA confirmation)' : ''}`,
        },
      });

      return createdSale;
    });

    let paymentInitiated = false;
    if (finalPaymentMethod === 'MPESA' && normalizedPhone) {
      try {
        const paymentRequest = await initiateMpesaStkPush({
          orderNumber: sale.receiptNumber,
          amount: sale.total,
          phone: normalizedPhone,
        });
        paymentInitiated = (await db.posSale.updateMany({
          where: { id: sale.id, paymentStatus: 'PENDING', mpesaCheckoutRequestId: null },
          data: {
            mpesaCheckoutRequestId: paymentRequest.checkoutRequestId,
            mpesaMerchantRequestId: paymentRequest.merchantRequestId,
            mpesaInitiatedAt: new Date(),
          },
        })).count === 1;
      } catch (error) {
        // STK Push definitively failed — Safaricom returned an error or the
        // request timed out before reaching Daraja. We mark the sale FAILED
        // and restore stock so inventory can never be permanently stranded.
        // If the failure is a network timeout (ambiguous), the reconciliation
        // mechanism will catch any callback that Safaricom still delivers.
        console.error(`M-PESA STK initiation failed for ${sale.receiptNumber}:`, error instanceof Error ? error.message : error);

        await db.$transaction(async (tx: any) => {
          await tx.posSale.updateMany({
            where: { id: sale.id, paymentStatus: 'PENDING' },
            data: { paymentStatus: 'FAILED' },
          });
          await releaseFailedPosSaleReservation(tx, sale, `M-PESA STK initiation failed for receipt #${sale.receiptNumber}`);
          await tx.auditLog.create({
            data: {
              actor: session.cashierName,
              action: 'PAYMENT_FAILED',
              details: `M-PESA STK initiation failed for receipt #${sale.receiptNumber}. Stock restored. Error: ${error instanceof Error ? error.message : 'unknown'}`,
            },
          });
        });

        // Return a clear error so the POS shows the cashier an actionable message
        // rather than showing a pending state that will never resolve.
        throw ApiError.badRequest(
          'M-PESA payment could not be initiated. Stock has been released. Please retry or accept cash.',
          'PAYMENT_FAILED',
        );
      }
    }

    res.status(201).json({
      success: true,
      receiptNumber,
      sale: { ...sale, items: JSON.parse(sale.items) },
      paymentInitiated,
      signals: {
        cashDrawerKickout: finalPaymentMethod === 'CASH',
        receiptPrinterTrigger: finalPaymentMethod !== 'MPESA',
      },
    });
  } catch (error) {
    next(error);
  }
});

// ── GET /api/pos/sales ─────────────────────────────────────────────────────
router.get('/sales', requireAdmin, requireRole('OWNER'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const sales = await db.posSale.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    res.json(sales.map((s: any) => ({ ...s, items: JSON.parse(s.items) })));
  } catch (error) {
    next(error);
  }
});

// ── GET /api/pos/audit-logs ────────────────────────────────────────────────
router.get('/audit-logs', requireAdmin, requireRole('OWNER'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const logs = await db.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    res.json(logs);
  } catch (error) {
    next(error);
  }
});

export default router;
