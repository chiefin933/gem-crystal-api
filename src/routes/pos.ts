import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiError } from '../lib/ApiError';
import { AuthRequest, requireAdmin, requireRole } from '../middleware/auth';
import { isMpesaConfigured, normalizeMpesaPhone } from '../services/mpesa';
import { eventBus } from '../events/EventBus';
import { releaseFailedOrderReservation } from './orderHelpers';

/**
 * completeSaleAtomically — deducts stock and marks a POS sale COMPLETED.
 * Called immediately for CASH sales and from POST /sales/:id/complete for MPESA.
 * Uses atomic SQL RETURNING so InventoryMovement records DB-verified values.
 */
async function completeSaleAtomically(db: any, sale: any, session: { cashierName: string }, ipAddress: string): Promise<any> {
  const toNum = (v: any) => (v && typeof v === 'object' ? v.toNumber() : Number(v));

  const result = await db.$transaction(async (tx: any) => {
    // Guard: only complete if still OPEN
    const updated = await tx.posSale.updateMany({
      where: { id: sale.id, saleStatus: 'OPEN' },
      data: { saleStatus: 'COMPLETED', completedAt: new Date() },
    });
    if (updated.count !== 1) return tx.posSale.findUnique({ where: { id: sale.id } });

    const lineItems = JSON.parse(sale.items) as Array<{
      variantId: string; title: string; size: string; color: string; quantity: number;
    }>;
    for (const item of lineItems) {
      const rows = await tx.$queryRaw<Array<{ stockQuantity: number }>>`
        UPDATE "Variant" SET "stockQuantity" = "stockQuantity" - ${item.quantity}
        WHERE "id" = ${item.variantId} AND "stockQuantity" >= ${item.quantity}
        RETURNING "stockQuantity"
      `;
      if (rows.length !== 1) {
        throw ApiError.outOfStock(`"${item.title}" (${item.size}/${item.color}) went out of stock`);
      }
      await tx.inventoryMovement.create({
        data: {
          variantId: item.variantId, type: 'SALE', quantity: -item.quantity,
          previousStock: rows[0].stockQuantity + item.quantity, newStock: rows[0].stockQuantity,
          reason: `POS sale completed #${sale.receiptNumber}`, referenceType: 'POS_SALE',
          referenceId: sale.receiptNumber, actor: session.cashierName,
        },
      });
    }

    if (sale.paymentMethod === 'MPESA' && sale.mpesaReceipt) {
      const existing = await tx.salePayment.findFirst({ where: { posSaleId: sale.id, method: 'MPESA' } });
      if (!existing) {
        await tx.salePayment.create({
          data: { posSaleId: sale.id, method: 'MPESA', amount: toNum(sale.total), mpesaReceipt: sale.mpesaReceipt, status: 'CONFIRMED' },
        });
      }
    }

    await tx.auditLog.create({
      data: {
        actor: session.cashierName, action: 'SALE_COMPLETED',
        details: `Sale #${sale.receiptNumber} completed | KES ${toNum(sale.total)} | ${sale.paymentMethod} | stock deducted`,
        ipAddress,
      },
    });
    return tx.posSale.findUnique({ where: { id: sale.id } });
  });
  return result;
}

function toNum(v: { toNumber(): number } | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'object' ? v.toNumber() : Number(v);
}

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
  // Digits only — a PIN must be numeric, 4–12 characters.
  // This prevents accidentally setting alphabetic passwords as PINs and
  // ensures the bcrypt comparison is always against a numeric secret.
  pinCode:     z.string().trim().regex(/^\d{4,12}$/, 'PIN must be 4–12 digits'),
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
    (req as any).posSession = session; // { id, cashierId, cashierName, ... }
    next();
  } catch (error) {
    next(error);
  }
}

// ── GET /api/pos/payment-notifications ────────────────────────────────────
// Returns unacknowledged payment notifications to the POS terminal.
// Scoped to the active session — only notifications for sales created by
// THIS session are returned, preventing cross-terminal notification leakage.
// Notifications are NOT marked acknowledged here — the POS must confirm
// successful receipt by calling POST /payment-notifications/:id/acknowledge.
router.get('/payment-notifications', requirePosSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = (req as any).posSession as { id: string; cashierId: string };

    // Only surface notifications for POS sales that belong to this session.
    // We join through posSaleId → PosSale.sessionId for session-scoped delivery.
    // Order notifications (ecommerce) are not shown on the POS terminal.
    const notifications = await db.paymentNotification.findMany({
      where: {
        acknowledgedAt: null,
        posSaleId: { not: null },
        posSale: { sessionId: session.id },
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
      include: { posSale: { select: { sessionId: true } } },
    });

    res.json({
      success: true,
      notifications: notifications.map((n: any) => ({
        id: n.id,
        orderNumber: n.paymentReference,
        customerName: n.customerName,
        customerPhone: n.customerPhone,
        amount: n.amount instanceof Object ? n.amount.toNumber() : n.amount,
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
// Accessible to active POS sessions (cashier terminal) and authenticated admins
// (monitoring dashboard). Uses a flexible guard that accepts either token type.
router.get('/hardware', async (req: Request, res: Response, next: NextFunction) => {
  // Accept either a valid POS session token or a valid admin JWT
  const token = getPosToken(req);
  let authorized = false;

  if (token) {
    // Try POS session first
    try {
      const session = await db.posSession.findFirst({
        where: { sessionTokenHash: hashSessionToken(token), status: 'ACTIVE', expiresAt: { gt: new Date() } },
      });
      if (session) authorized = true;
    } catch { /* fall through to admin check */ }

    // Try admin JWT if POS session didn't match
    if (!authorized) {
      try {
        const jwt = await import('jsonwebtoken');
        const JWT_SECRET = process.env.JWT_SECRET!;
        jwt.default.verify(token, JWT_SECRET, { issuer: 'gem-crystal-api', audience: 'gem-crystal-admin' });
        authorized = true;
      } catch { /* not a valid admin token either */ }
    }
  }

  if (!authorized) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    return;
  }

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

// ── PATCH /api/pos/hardware ────────────────────────────────────────────────
// Owner only: update hardware connection status flags.
router.patch('/hardware', requireAdmin, requireRole('OWNER'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const allowedFields = ['tabletName', 'tabletConnected', 'barcodeScanner', 'fingerprintReader', 'receiptPrinter', 'cashDrawer', 'status'] as const;
    const update: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) update[field] = req.body[field];
    }
    if (Object.keys(update).length === 0) {
      res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'No updatable fields provided' } });
      return;
    }
    const hw = await db.hardwareConfig.update({ where: { id: 'pos-01' }, data: update });
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
    const session = (req as any).posSession as { id: string; cashierId: string; cashierName: string };

    // F9: Enforce session linkage — every sale must be traceable to a cashier and session.
    // These fields come from requirePosSession middleware; throw if somehow missing.
    if (!session.id || !session.cashierId || !session.cashierName) {
      throw ApiError.unauthorized('Invalid POS session — cannot create sale without session context');
    }
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
        price: toNum(variant.salePrice ?? variant.price),
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
    if (finalPaymentMethod === 'CASH' && Number(cashReceived) < serverTotal) {      throw ApiError.badRequest('Cash received is less than the sale total');
    }

    const receiptNumber = offlineReceiptId || ('GC-POS-' + crypto.randomBytes(5).toString('hex').toUpperCase());
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
      // Stock availability check — warn cashier now but do NOT deduct yet.
      // Stock is deducted atomically inside POST /sales/:id/complete after
      // payment is confirmed. This satisfies the payment-first invariant.
      for (const item of lineItems) {
        const variant = variantsById.get(item.variantId);
        if (!variant) throw ApiError.notFound(`Product variant ${item.variantId} was not found`);
        if (variant.stockQuantity < item.quantity) {
          throw ApiError.outOfStock(
            `Item "${item.title}" (${item.size}/${item.color}) — only ${variant.stockQuantity} left`
          );
        }
      }

      const createdSale = await tx.posSale.create({
        data: {
          receiptNumber,
          cashierId: session.cashierId,
          cashierName: session.cashierName,
          sessionId: session.id,
          deviceId: 'Tablet POS 01',
          customerName: finalCustomerName,
          mpesaReceipt: finalPaymentMethod === 'MPESA' ? null : (mpesaReceipt || null),
          items: JSON.stringify(lineItems),
          subtotal: serverSubtotal,
          discount: serverDiscount,
          total: serverTotal,
          paymentMethod: finalPaymentMethod,
          // CASH is immediately PAID; M-PESA waits for C2B callback confirmation
          paymentStatus: finalPaymentMethod === 'MPESA' ? 'PENDING' : 'PAID',
          paymentExpiresAt: finalPaymentMethod === 'MPESA'
            ? new Date(Date.now() + 30 * 60 * 1000)
            : null,
          cashReceived: finalPaymentMethod === 'CASH' ? Number(cashReceived) : null,
          changeGiven: finalPaymentMethod === 'CASH' ? Math.max(0, Number(cashReceived) - serverTotal) : null,
          customerPhone: normalizedPhone ?? null,
          // saleStatus starts OPEN — completed by cashier after payment confirmed
          saleStatus: 'OPEN',
        },
      });

      // Record cash payment in the SalePayment ledger immediately
      if (finalPaymentMethod === 'CASH') {
        await tx.salePayment.create({
          data: {
            posSaleId: createdSale.id,
            method: 'CASH',
            amount: serverTotal,
            status: 'CONFIRMED',
          },
        });
      }

      if (customerPhone) {
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

    // For CASH: complete the sale immediately since payment is in hand.
    // This deducts stock atomically and finalises the sale in one step.
    if (finalPaymentMethod === 'CASH') {
      await completeSaleAtomically(db, sale, session, req.ip ?? '');
    }

    // For CASH sales, emit SaleCreated immediately after the transaction.
    // MPESA sales emit SaleCreated from the M-PESA callback (after payment confirmation).
    if (finalPaymentMethod === 'CASH') {
      setImmediate(() => eventBus.emit('SaleCreated', {
        receiptNumber: sale.receiptNumber,
        cashierName: sale.cashierName,
        customerName: sale.customerName,
        customerPhone: sale.customerPhone ?? null,
        total: toNum(sale.total),
        paymentMethod: sale.paymentMethod,
        mpesaReceipt: null,
        items: JSON.parse(sale.items),
      }));
    }

    // ── C2B Till payment architecture ─────────────────────────────────────
    // The POS no longer initiates an STK Push. Instead:
    //   1. Sale is created as PENDING with a unique idempotency key
    //   2. Cashier shows the customer: Till number + amount + receipt ref
    //   3. Customer independently pays via Lipa na M-PESA → Buy Goods
    //   4. Safaricom sends C2B callback to /api/orders/mpesa-c2b-callback
    //   5. Backend verifies and matches payment to this sale
    //   6. PaymentNotification appears on POS (3s poll)
    //   7. Cashier acknowledges, then calls POST /sales/:id/complete
    if (finalPaymentMethod === 'MPESA') {
      // Write idempotency key so the C2B callback can correlate by receipt number
      const idempotencyKey = crypto.randomBytes(16).toString('hex');
      await db.posSale.update({
        where: { id: sale.id },
        data: { mpesaIdempotencyKey: idempotencyKey, mpesaInitiatedAt: new Date() },
      });

      await db.auditLog.create({
        data: {
          actor: session.cashierName,
          action: 'PAYMENT_PENDING',
          details: `POS sale #${sale.receiptNumber} awaiting customer Till payment — KES ${toNum(sale.total)}. Idempotency key recorded.`,
        },
      });
    }

    const tillNumber = process.env.MPESA_TILL_NUMBER || null;

    res.status(201).json({
      success: true,
      receiptNumber,
      sale: { ...sale, items: JSON.parse(sale.items) },
      // C2B: no server-initiated payment prompt — customer pays independently
      paymentInitiated: false,
      tillNumber,
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
router.get('/sales', requireAdmin, requireRole('OWNER'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page  = Math.max(1, parseInt(String(req.query.page  ?? 1), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? 50), 10)));
    const skip  = (page - 1) * limit;

    const [sales, total] = await Promise.all([
      db.posSale.findMany({ orderBy: { createdAt: 'desc' }, skip, take: limit }),
      db.posSale.count(),
    ]);

    res.json({
      data: sales.map((s: any) => ({ ...s, items: JSON.parse(s.items) })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
});

// ── GET /api/pos/audit-logs ────────────────────────────────────────────────
router.get('/audit-logs', requireAdmin, requireRole('OWNER'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page     = Math.max(1, parseInt(String(req.query.page   ?? 1),   10));
    const limit    = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? 50), 10)));
    const skip     = (page - 1) * limit;
    const category = typeof req.query.category === 'string' ? req.query.category.toUpperCase() : null;

    // Category filter maps friendly names to action prefixes
    const ACTION_PREFIXES: Record<string, string[]> = {
      LOGIN:     ['LOGIN', 'LOGOUT', 'POS_LOGIN', 'POS_LOGOUT'],
      POS:       ['POS_LOGIN', 'POS_LOGOUT', 'SALE_CREATED'],
      SALES:     ['SALE_CREATED'],
      PAYMENTS:  ['PAYMENT_'],
      INVENTORY: ['INVENTORY_'],
      ORDERS:    ['ORDER_'],
      SETTINGS:  ['SETTINGS_'],
      SECURITY:  ['POS_LOGIN', 'PAYMENT_STATUS_OVERRIDDEN', 'ADMIN_'],
    };

    const where: any = {};
    if (category && category !== 'ALL' && ACTION_PREFIXES[category]) {
      where.OR = ACTION_PREFIXES[category].map(prefix => ({
        action: { startsWith: prefix },
      }));
    }

    const [logs, total] = await Promise.all([
      db.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      db.auditLog.count({ where }),
    ]);

    res.json({
      data: logs,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
});

// ── POST /api/pos/sales/:id/complete ──────────────────────────────────────
// Cashier confirms the customer has paid and the sale is finalised.
// For CASH: called immediately after checkout.
// For M-PESA: called after the cashier acknowledges the payment popup.
//
// Guards enforced:
//   • Active POS session required
//   • Cashier can only complete their own sales (sessionId match)
//   • Sale must exist and belong to this session
//   • Payment must be PAID
//   • Amount in the sale must be positive
//   • Duplicate completion is safe (idempotent)
//   • Update is atomic — uses updateMany with status guard to prevent
//     double-completion under concurrent requests
router.post('/sales/:id/complete', requirePosSession, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = (req as any).posSession as { id: string; cashierId: string; cashierName: string };

    const sale = await db.posSale.findUnique({ where: { id: req.params.id } });
    if (!sale) throw ApiError.notFound('POS sale not found');

    // Session-scoped ownership: the sale must belong to this cashier's session
    if (sale.sessionId && sale.sessionId !== session.id) {
      throw ApiError.forbidden('This sale belongs to a different POS session');
    }
    if (sale.cashierId && sale.cashierId !== session.cashierId) {
      throw ApiError.forbidden('You can only complete your own sales');
    }

    // Idempotent — already completed is not an error
    if (sale.saleStatus === 'COMPLETED') {
      res.json({ success: true, message: 'Sale already completed', sale: { ...sale, items: JSON.parse(sale.items) } });
      return;
    }

    if (sale.saleStatus === 'CANCELLED' || sale.saleStatus === 'EXPIRED') {
      throw ApiError.badRequest(`Cannot complete a ${sale.saleStatus} sale`);
    }

    if (sale.paymentStatus !== 'PAID') {
      throw ApiError.badRequest(
        `Payment must be confirmed before completing the sale (current: ${sale.paymentStatus})`,
      );
    }

    if (toNum(sale.total) <= 0) {
      throw ApiError.badRequest('Sale total must be greater than zero');
    }

    // Use shared helper — deducts stock atomically and marks COMPLETED
    const finalSale = await completeSaleAtomically(db, sale, session, req.ip ?? '');
    res.json({ success: true, sale: { ...finalSale, items: JSON.parse(finalSale.items) } });
  } catch (error) {
    next(error);
  }
});

// ── POST /api/pos/expire-pending ───────────────────────────────────────────
// Owner/scheduled: expire pending POS sales AND ecommerce orders whose
// payment window has passed, releasing their stock reservations.
// Call this from a cron job (e.g. every 5 minutes) or trigger manually.
// Uses paymentExpiresAt when set; falls back to timeoutMinutes from createdAt.
router.post('/expire-pending', requireAdmin, requireRole('OWNER'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const timeoutMinutes = Number(req.body?.timeoutMinutes ?? 30);
    const now = new Date();
    const fallbackCutoff = new Date(now.getTime() - timeoutMinutes * 60 * 1000);

    // Expired condition: paymentExpiresAt has passed OR createdAt older than fallback
    const expiredCondition = {
      OR: [
        { paymentExpiresAt: { lte: now } },
        { paymentExpiresAt: null, createdAt: { lt: fallbackCutoff } },
      ],
    };

    // ── Expire POS sales ──────────────────────────────────────────────────
    const pendingSales = await db.posSale.findMany({
      where: { paymentStatus: { in: ['PENDING', 'PENDING_CORRELATION'] }, ...expiredCondition },
    });

    let expiredSales = 0;
    for (const sale of pendingSales) {
      await db.$transaction(async (tx: any) => {
        await tx.posSale.update({
          where: { id: sale.id },
          data: { paymentStatus: 'FAILED', saleStatus: 'EXPIRED' },
        });
        await releaseFailedPosSaleReservation(
          tx, sale,
          `Auto-expired: receipt #${sale.receiptNumber}`,
        );
        await tx.auditLog.create({
          data: {
            actor: 'System',
            action: 'PAYMENT_FAILED',
            details: `POS sale #${sale.receiptNumber} payment expired — stock restored`,
          },
        });
      });
      expiredSales++;
    }

    // ── Expire ecommerce orders ───────────────────────────────────────────
    const pendingOrders = await prisma.order.findMany({
      where: {
        paymentStatus: { in: ['PENDING', 'PENDING_CORRELATION'] },
        ...expiredCondition,
      } as any,
    });

    let expiredOrders = 0;
    for (const order of pendingOrders) {
      await prisma.$transaction(async (tx) => {
        await tx.order.update({
          where: { id: order.id },
          data: { paymentStatus: 'FAILED' },
        });
        await releaseFailedOrderReservation(tx, order, `Auto-expired: order #${order.orderNumber}`);
        await tx.auditLog.create({
          data: {
            actor: 'System',
            action: 'PAYMENT_FAILED',
            details: `Order #${order.orderNumber} payment expired — stock restored`,
            ipAddress: null,
          },
        });
      });
      expiredOrders++;
    }

    res.json({
      success: true,
      expiredSales,
      expiredOrders,
      message: `${expiredSales} POS sale(s) and ${expiredOrders} order(s) expired — stock released`,
    });
  } catch (error) {
    next(error);
  }
});
// Admin: list active POS sessions so the monitoring dashboard shows real data.
router.get('/sessions', requireAdmin, requireRole('OWNER'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const sessions = await db.posSession.findMany({
      where: { status: 'ACTIVE', expiresAt: { gt: new Date() } },
      orderBy: { startTime: 'desc' },
      select: {
        id: true,
        cashierId: true,
        cashierName: true,
        approvedBy: true,
        status: true,
        startTime: true,
        expiresAt: true,
      },
    });
    res.json({ success: true, sessions });
  } catch (error) {
    next(error);
  }
});

export default router;
