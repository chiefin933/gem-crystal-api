import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { generateToken, requireAdmin, requireRole, AuthRequest } from '../middleware/auth';

const router = Router();

// ── POST /api/admin/login ─────────────────────────────────────────────────
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body as { email: string; password: string };

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const admin = await prisma.admin.findUnique({ where: { email: email.toLowerCase().trim() } });

    if (!admin) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const isValid = await bcrypt.compare(password, admin.passwordHash);
    if (!isValid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    if (admin.role !== 'OWNER') {
      res.status(403).json({ error: 'Owner access is required for the admin panel' });
      return;
    }

    const token = generateToken(admin.id, admin.email, admin.role as 'OWNER' | 'CASHIER');

    res.json({
      token,
      admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Login failed' });
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
