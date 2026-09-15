import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { generateToken, requireAdmin, requireRole, AuthRequest } from '../middleware/auth';

const router = Router();

/** Convert Prisma Decimal or number to plain JS number. */
function toNum(v: { toNumber(): number } | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'object' ? v.toNumber() : Number(v);
}

/**
 * The owner dashboard reports calendar-day sales in the boutique's local
 * timezone, not the timezone of whichever server happens to run the API.
 * Nairobi does not observe daylight saving time, but these helpers still use
 * Intl so the configured timezone remains explicit and easy to change.
 */
const BUSINESS_TIME_ZONE = process.env.BUSINESS_TIME_ZONE || 'Africa/Nairobi';

type BusinessDateParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function businessDateParts(date: Date): BusinessDateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)]),
  ) as Record<string, number>;

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function businessDayStart(now: Date, daysBefore = 0): Date {
  const local = businessDateParts(now);
  const calendarDate = new Date(Date.UTC(local.year, local.month - 1, local.day - daysBefore));

  // Africa/Nairobi is UTC+03:00. Derive the offset via Intl so this remains
  // correct when BUSINESS_TIME_ZONE is deliberately changed in configuration.
  const midnightAsUtc = Date.UTC(
    calendarDate.getUTCFullYear(),
    calendarDate.getUTCMonth(),
    calendarDate.getUTCDate(),
  );
  const offsetParts = businessDateParts(new Date(midnightAsUtc));
  const offsetMs = Date.UTC(
    offsetParts.year,
    offsetParts.month - 1,
    offsetParts.day,
    offsetParts.hour,
    offsetParts.minute,
    offsetParts.second,
  ) - midnightAsUtc;

  return new Date(midnightAsUtc - offsetMs);
}

function businessDateKey(date: Date): string {
  const local = businessDateParts(date);
  return `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
}

type SalesPeriod = {
  key: 'today' | 'yesterday' | 'last7Days' | 'last30Days';
  label: string;
  description: string;
  startsAt: Date;
  endsAt: Date;
};

function createSalesPeriods(now: Date): SalesPeriod[] {
  const todayStart = businessDayStart(now);
  // Use an exclusive end so a completed sale can never be counted twice at a
  // midnight boundary. The current instant is advanced by 1ms to include it.
  const nowExclusive = new Date(now.getTime() + 1);

  return [
    { key: 'today', label: 'Today', description: 'Since midnight', startsAt: todayStart, endsAt: nowExclusive },
    { key: 'yesterday', label: 'Yesterday', description: 'Previous calendar day', startsAt: businessDayStart(now, 1), endsAt: todayStart },
    { key: 'last7Days', label: 'Last 7 days', description: 'Rolling window, including today', startsAt: businessDayStart(now, 6), endsAt: nowExclusive },
    { key: 'last30Days', label: 'Last 30 days', description: 'Rolling window, including today', startsAt: businessDayStart(now, 29), endsAt: nowExclusive },
  ];
}

// ── Validation schema ─────────────────────────────────────────────────────
const AdminLoginSchema = z.object({
  email: z
    .string({ required_error: 'Email is required' })
    .trim()
    .toLowerCase()
    .email('Invalid email format')
    .max(254, 'Email exceeds maximum length'),
  password: z
    .string({ required_error: 'Password is required' })
    .min(6, 'Password too short')
    .max(128, 'Password exceeds maximum length'),
});

// ── POST /api/admin/login ─────────────────────────────────────────────────
router.post('/login', async (req: Request, res: Response) => {
  const parsed = AdminLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    // Return a generic message — don't reveal which field failed
    // to avoid leaking account-enumeration information.
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request payload' },
    });
    return;
  }

  try {
    const { email, password } = parsed.data;

    const admin = await prisma.admin.findUnique({ where: { email } });

    // Constant-time-ish: always run bcrypt even if account not found
    // to prevent timing-based account enumeration.
    const passwordHash = admin?.passwordHash ?? '$2a$12$invalidhashtopreventtimingleak000000000000000000000000';
    const isValid = await bcrypt.compare(password, passwordHash);

    if (!admin || !isValid) {
      res.status(401).json({
        success: false,
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' },
      });
      return;
    }

    if (admin.role !== 'OWNER') {
      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Owner access is required for the admin panel' },
      });
      return;
    }

    const token = generateToken(admin.id, admin.email, admin.role as 'OWNER' | 'CASHIER', admin.tokenVersion);

    // Return token and admin at the top level so both the Admin and POS
    // frontends can read res.token / res.admin directly without unwrapping
    // a nested data object. success:true is kept for API consistency.
    res.json({
      success: true,
      token,
      admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Login failed' },
    });
  }
});

// ── POST /api/admin/logout ────────────────────────────────────────────────
// Increment the server-side token version before telling the browser to discard
// its token. This invalidates every outstanding JWT for this owner immediately,
// including a token copied from a lost or compromised device.
router.post('/logout', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    await prisma.admin.update({
      where: { id: req.adminId },
      data: { tokenVersion: { increment: 1 } },
    });
    res.json({
      success: true,
      data: { message: 'Logged out successfully.' },
    });
  } catch {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Logout failed' },
    });
  }
});

// ── GET /api/admin/me ─────────────────────────────────────────────────────
router.get('/me', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const admin = await prisma.admin.findUnique({
      where: { id: req.adminId },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });
    if (!admin) { res.status(404).json({ error: 'Admin not found' }); return; }
    res.json(admin);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch admin' });
  }
});

// ── GET /api/admin/stats ──────────────────────────────────────────────────
// Dashboard KPI stats — covers the ENTIRE boutique (ecommerce + POS)
router.get('/stats', requireAdmin, requireRole('OWNER'), async (_req: AuthRequest, res: Response) => {
  try {
    const completedPosSaleWhere = { saleStatus: 'COMPLETED', paymentStatus: 'PAID' };

    const [
      totalProducts,
      totalOrders,
      paidOrders,
      pendingOrders,
      lowStockVariants,
      coupons,
      // POS sales aggregates
      posPaidSales,
      posMpesaAgg,
      posCashAgg,
      // Ecommerce aggregates by payment method
      ecomMpesaAgg,
      ecomCardAgg,
    ] = await Promise.all([
      prisma.product.count({ where: { isActive: true } }),
      prisma.order.count(),
      prisma.order.findMany({ where: { paymentStatus: 'PAID' }, select: { total: true } }),
      prisma.order.count({ where: { fulfillmentStatus: 'PENDING' } }),
      prisma.variant.findMany({
        where: { stockQuantity: { lte: 5 } },
        include: { product: { select: { title: true, category: true } } },
        orderBy: { stockQuantity: 'asc' },
        take: 20,
      }),
      prisma.coupon.count({ where: { isActive: true } }),
      // POS paid sales — use saleStatus=COMPLETED so revenue reflects
      // only fully finalized sales, not just payment confirmations
      (prisma as any).posSale.findMany({ where: completedPosSaleWhere, select: { total: true } }),
      (prisma as any).posSale.aggregate({ where: { ...completedPosSaleWhere, paymentMethod: 'MPESA' }, _sum: { total: true } }),
      (prisma as any).posSale.aggregate({ where: { ...completedPosSaleWhere, paymentMethod: 'CASH' }, _sum: { total: true } }),
      // Ecommerce by method
      prisma.order.aggregate({ where: { paymentMethod: 'MPESA', paymentStatus: 'PAID' }, _sum: { total: true } }),
      prisma.order.aggregate({ where: { paymentMethod: 'CARD', paymentStatus: 'PAID' }, _sum: { total: true } }),
    ]);

    // Ecommerce revenue
    const ecomRevenue = paidOrders.reduce((sum, o) => sum + toNum(o.total), 0);
    const avgOrderValue = paidOrders.length > 0 ? ecomRevenue / paidOrders.length : 0;

    // POS revenue
    const posRevenue: number = posPaidSales.reduce((sum: number, s: any) => sum + toNum(s.total), 0);

    // Combined totals
    const totalRevenue = ecomRevenue + posRevenue;

    // Payment method breakdown (ecommerce + POS combined)
    const ecomMpesa: number = toNum(ecomMpesaAgg._sum.total);
    const ecomCard: number  = toNum(ecomCardAgg._sum.total);
    const posMpesa: number  = toNum(posMpesaAgg._sum.total);
    const posCash:  number  = toNum(posCashAgg._sum.total);

    // ── Owner sales periods — database-calculated, never browser-derived ───
    const statsGeneratedAt = new Date();
    const salesPeriods = await Promise.all(
      createSalesPeriods(statsGeneratedAt).map(async period => {
        const [website, pos] = await Promise.all([
          prisma.order.aggregate({
            where: { paymentStatus: 'PAID', paidAt: { gte: period.startsAt, lt: period.endsAt } },
            _sum: { total: true },
            _count: true,
          }),
          (prisma as any).posSale.aggregate({
            where: { ...completedPosSaleWhere, completedAt: { gte: period.startsAt, lt: period.endsAt } },
            _sum: { total: true },
            _count: true,
          }),
        ]);

        return {
          key: period.key,
          label: period.label,
          description: period.description,
          revenue: Math.round(toNum(website._sum.total) + toNum(pos._sum.total)),
          transactions: website._count + pos._count,
        };
      }),
    );

    // ── Sales by day — last 14 days ───────────────────────────────────────
    const fourteenDaysAgo = businessDayStart(statsGeneratedAt, 13);

    const [recentOrders, recentPosSales] = await Promise.all([
      prisma.order.findMany({
        where: { paymentStatus: 'PAID', paidAt: { gte: fourteenDaysAgo } },
        select: { paidAt: true, total: true },
      }),
      (prisma as any).posSale.findMany({
        where: { ...completedPosSaleWhere, completedAt: { gte: fourteenDaysAgo } },
        select: { completedAt: true, total: true },
      }),
    ]);

    // Build date→revenue map for the last 14 days
    const dayMap = new Map<string, number>();
    for (let i = 13; i >= 0; i--) {
      const d = businessDayStart(statsGeneratedAt, i);
      dayMap.set(businessDateKey(d), 0);
    }
    for (const o of recentOrders) {
      if (o.paidAt) {
        const key = businessDateKey(o.paidAt);
        if (dayMap.has(key)) dayMap.set(key, (dayMap.get(key) ?? 0) + toNum(o.total));
      }
    }
    for (const s of recentPosSales) {
      if (s.completedAt) {
        const key = businessDateKey(s.completedAt);
        if (dayMap.has(key)) dayMap.set(key, (dayMap.get(key) ?? 0) + toNum(s.total));
      }
    }
    const salesByDay = [...dayMap.entries()].map(([date, revenue]) => ({ date, revenue: Math.round(revenue) }));

    // ── Top products by units sold (last 30 days) ─────────────────────────
    const thirtyDaysAgo = businessDayStart(statsGeneratedAt, 29);

    const [ordersForRanking, posForRanking] = await Promise.all([
      prisma.order.findMany({
        where: { paymentStatus: 'PAID', paidAt: { gte: thirtyDaysAgo } },
        select: { items: true },
      }),
      (prisma as any).posSale.findMany({
        where: { ...completedPosSaleWhere, completedAt: { gte: thirtyDaysAgo } },
        select: { items: true },
      }),
    ]);

    const productSales = new Map<string, { title: string; units: number; revenue: number }>();
    const allSalesItems = [...ordersForRanking, ...posForRanking];
    for (const record of allSalesItems) {
      try {
        const items = JSON.parse(record.items) as Array<{ title: string; quantity: number; price: number }>;
        for (const item of items) {
          const existing = productSales.get(item.title) ?? { title: item.title, units: 0, revenue: 0 };
          existing.units   += item.quantity;
          existing.revenue += item.price * item.quantity;
          productSales.set(item.title, existing);
        }
      } catch { /* skip malformed */ }
    }

    const sortedProducts = [...productSales.values()].sort((a, b) => b.units - a.units);
    const topProducts  = sortedProducts.slice(0, 5).map(p => ({ ...p, revenue: Math.round(p.revenue) }));
    const slowProducts = sortedProducts.slice(-5).reverse().map(p => ({ ...p, revenue: Math.round(p.revenue) }));

    res.json({
      totalProducts, totalOrders, pendingOrders, avgOrderValue, activeCoupons: coupons,
      totalRevenue, ecomRevenue, posRevenue,
      mpesaRevenue: ecomMpesa + posMpesa, cashRevenue: posCash, cardRevenue: ecomCard,
      ecomMpesaRevenue: ecomMpesa, posMpesaRevenue: posMpesa, posCashRevenue: posCash,
      // Analytics
      salesPeriods: {
        timeZone: BUSINESS_TIME_ZONE,
        generatedAt: statsGeneratedAt.toISOString(),
        periods: salesPeriods,
      },
      salesByDay,
      topProducts,
      slowProducts,
      lowStockVariants: lowStockVariants.map(v => ({
        variantId: v.id, sku: v.sku, size: v.size, color: v.color,
        stockQuantity: v.stockQuantity, productTitle: v.product.title, productCategory: v.product.category,
      })),
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;
