import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { requireAdmin, requireRole, AuthRequest } from '../middleware/auth';

const router = Router();

// ── POST /api/coupons/validate ────────────────────────────────────────────
// Public: validate a coupon code before checkout
router.post('/validate', async (req: Request, res: Response) => {
  try {
    const { code, orderTotal } = req.body as { code: string; orderTotal: number };

    if (!code) {
      res.status(400).json({ valid: false, error: 'No coupon code provided' });
      return;
    }

    const coupon = await prisma.coupon.findUnique({
      where: { code: code.trim().toUpperCase() },
    });

    if (!coupon) {
      res.status(404).json({ valid: false, error: 'Coupon code not found' });
      return;
    }
    if (!coupon.isActive) {
      res.status(400).json({ valid: false, error: 'This coupon is no longer active' });
      return;
    }
    if (coupon.usageCount >= coupon.usageLimit) {
      res.status(400).json({ valid: false, error: 'This coupon has reached its usage limit' });
      return;
    }
    if (new Date(coupon.expiryDate) < new Date()) {
      res.status(400).json({ valid: false, error: 'This coupon has expired' });
      return;
    }
    if (orderTotal < coupon.minOrderAmount) {
      res.status(400).json({
        valid: false,
        error: `Minimum order of KES ${coupon.minOrderAmount.toLocaleString()} required for this coupon`,
      });
      return;
    }

    const discountAmount = coupon.discountType === 'PERCENTAGE'
      ? (orderTotal * coupon.discountValue) / 100
      : coupon.discountValue;

    res.json({
      valid: true,
      coupon: {
        code: coupon.code,
        discountType: coupon.discountType,
        discountValue: coupon.discountValue,
        discountAmount: Math.min(discountAmount, orderTotal),
      },
    });
  } catch (error) {
    res.status(500).json({ valid: false, error: 'Failed to validate coupon' });
  }
});

// ── GET /api/coupons ──────────────────────────────────────────────────────
// Admin: list all coupons
router.get('/', requireAdmin, requireRole('OWNER'), async (_req: AuthRequest, res: Response) => {
  try {
    const coupons = await prisma.coupon.findMany({ orderBy: { code: 'asc' } });
    res.json(coupons);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch coupons' });
  }
});

// ── POST /api/coupons ─────────────────────────────────────────────────────
// Admin: create a new coupon
router.post('/', requireAdmin, requireRole('OWNER'), async (req: AuthRequest, res: Response) => {
  try {
    const { code, discountType, discountValue, minOrderAmount, expiryDate, usageLimit } = req.body;

    const coupon = await prisma.coupon.create({
      data: {
        code: code.trim().toUpperCase(),
        discountType,
        discountValue: Number(discountValue),
        minOrderAmount: Number(minOrderAmount) || 0,
        expiryDate,
        usageLimit: Number(usageLimit) || 100,
        usageCount: 0,
        isActive: true,
      },
    });

    res.status(201).json(coupon);
  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(409).json({ error: 'Coupon code already exists' });
      return;
    }
    res.status(500).json({ error: 'Failed to create coupon' });
  }
});

// ── PATCH /api/coupons/:code/toggle ───────────────────────────────────────
// Admin: activate / deactivate a coupon
router.patch('/:code/toggle', requireAdmin, requireRole('OWNER'), async (req: AuthRequest, res: Response) => {
  try {
    const coupon = await prisma.coupon.findUnique({ where: { code: req.params.code } });
    if (!coupon) { res.status(404).json({ error: 'Coupon not found' }); return; }

    const updated = await prisma.coupon.update({
      where: { code: req.params.code },
      data: { isActive: !coupon.isActive },
    });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: 'Failed to toggle coupon' });
  }
});

// ── DELETE /api/coupons/:code ─────────────────────────────────────────────
// Admin: delete a coupon
router.delete('/:code', requireAdmin, requireRole('OWNER'), async (req: AuthRequest, res: Response) => {
  try {
    await prisma.coupon.delete({ where: { code: req.params.code } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete coupon' });
  }
});

export default router;
