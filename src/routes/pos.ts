import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { ApiError } from '../lib/ApiError';
import { AuthRequest, requireAdmin, requireRole } from '../middleware/auth';
import { initiateMpesaStkPush, isMpesaConfigured, normalizeMpesaPhone } from '../services/mpesa';

const router = Router();
// Prisma Client is regenerated after the schema change. Keep this route compatible
// with an older generated client during the migration step.
const db = prisma as any;

const REQUEST_TTL_MS = 2 * 60 * 1000;
const POS_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

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
// A confirmed payment is acknowledged only when an authenticated POS session
// retrieves it. This gives the cashier one clear alert without exposing sales
// data to an unauthenticated browser or replaying it after acknowledgement.
router.get('/payment-notifications', requirePosSession, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const notifications = await db.$transaction(async (tx: any) => {
      const pending = await tx.paymentNotification.findMany({
        where: { acknowledgedAt: null },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });

      if (pending.length) {
        await tx.paymentNotification.updateMany({
          where: { id: { in: pending.map((notification: any) => notification.id) }, acknowledgedAt: null },
          data: { acknowledgedAt: new Date() },
        });
      }
      return pending;
    });

    res.json({
      success: true,
      notifications: notifications.map((notification: any) => ({
        id: notification.id,
        orderNumber: notification.paymentReference,
        customerName: notification.customerName,
        customerPhone: notification.customerPhone,
        amount: notification.amount,
        currency: notification.currency,
        paymentMethod: notification.paymentMethod,
        mpesaReceipt: notification.mpesaReceipt,
        confirmedAt: notification.createdAt,
      })),
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
router.post('/auth-request', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { cashierName, pinCode, biometricId, deviceId } = req.body as {
      cashierName?: string;
      pinCode?: string;
      biometricId?: string;
      deviceId?: string;
    };

    if (!cashierName || !pinCode) {
      throw ApiError.badRequest('Cashier Name and PIN Code are required', 'INVALID_CREDENTIALS');
    }

    const normalizedName = cashierName.trim();
    const cashier = await db.admin.findFirst({
      where: { name: normalizedName, role: 'CASHIER' },
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
    const finalPaymentMethod = ['CASH', 'MPESA', 'CARD'].includes(paymentMethod) ? paymentMethod : 'CASH';
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
        await tx.customer.upsert({
          where: { phone: customerPhone },
          update: { name: finalCustomerName },
          create: { name: finalCustomerName, phone: customerPhone },
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
        console.error(`M-PESA request could not be started for ${sale.receiptNumber}`, error instanceof Error ? error.message : 'unknown error');
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
