import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { generateToken, requireAdmin, requireRole, AuthRequest } from '../middleware/auth';

const router = Router();

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

    const token = generateToken(admin.id, admin.email, admin.role as 'OWNER' | 'CASHIER');

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
// Stateless JWT logout — instructs the client to discard its token.
// For full server-side revocation, a token blocklist/version field
// would be added to the Admin model (Phase 5 hardening).
router.post('/logout', requireAdmin, (_req: AuthRequest, res: Response) => {
  res.json({
    success: true,
    data: { message: 'Logged out successfully. Please discard your token.' },
  });
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
// Dashboard KPI stats
router.get('/stats', requireAdmin, requireRole('OWNER'), async (_req: AuthRequest, res: Response) => {
  try {
    const [totalProducts, totalOrders, paidOrders, pendingOrders, lowStockVariants, coupons] = await Promise.all([
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
    ]);

    const totalRevenue = paidOrders.reduce((sum, o) => sum + o.total, 0);
    const avgOrderValue = paidOrders.length > 0 ? totalRevenue / paidOrders.length : 0;

    // Revenue by payment method
    const mpesaOrders = await prisma.order.aggregate({
      where: { paymentMethod: 'MPESA', paymentStatus: 'PAID' },
      _sum: { total: true },
    });
    const cardOrders = await prisma.order.aggregate({
      where: { paymentMethod: 'CARD', paymentStatus: 'PAID' },
      _sum: { total: true },
    });

    res.json({
      totalProducts,
      totalOrders,
      totalRevenue,
      pendingOrders,
      avgOrderValue,
      activeCoupons: coupons,
      mpesaRevenue: mpesaOrders._sum.total || 0,
      cardRevenue: cardOrders._sum.total || 0,
      lowStockVariants: lowStockVariants.map(v => ({
        variantId: v.id,
        sku: v.sku,
        size: v.size,
        color: v.color,
        stockQuantity: v.stockQuantity,
        productTitle: v.product.title,
        productCategory: v.product.category,
      })),
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;
