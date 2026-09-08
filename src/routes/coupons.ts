import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAdmin, requireRole, AuthRequest } from '../middleware/auth';

const router = Router();

/** Convert Prisma Decimal or number to plain JS number. */
function toNum(v: { toNumber(): number } | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'object' ? v.toNumber() : Number(v);
}

// ── Coupon creation schema ─────────────────────────────────────────────────
const CouponCreateSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{3,32}$/, 'Code must be 3–32 uppercase alphanumeric characters'),
  discountType: z.enum(['PERCENTAGE', 'FIXED'], {
    errorMap: () => ({ message: 'discountType must be PERCENTAGE or FIXED' }),
  }),
  discountValue: z
    .number({ invalid_type_error: 'discountValue must be a number' })
    .positive('discountValue must be greater than 0'),
  minOrderAmount: z
    .number({ invalid_type_error: 'minOrderAmount must be a number' })
    .min(0, 'minOrderAmount cannot be negative')
    .default(0),
  expiryDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'expiryDate must be YYYY-MM-DD')
    .refine(d => new Date(d) > new Date(), { message: 'expiryDate must be in the future' }),
  usageLimit: z
    .number({ invalid_type_error: 'usageLimit must be a number' })
    .int('usageLimit must be an integer')
    .min(1, 'usageLimit must be at least 1')
    .max(100_000, 'usageLimit exceeds maximum')
    .default(100),
}).strict().superRefine((data, ctx) => {
  if (data.discountType === 'PERCENTAGE' && data.discountValue > 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['discountValue'],
      message: 'Percentage discount cannot exceed 100',
    });
  }
});

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
    if (orderTotal < toNum(coupon.minOrderAmount)) {
      res.status(400).json({
        valid: false,
        error: `Minimum order of KES ${toNum(coupon.minOrderAmount).toLocaleString()} required for this coupon`,
      });
      return;
    }

    const discountAmount = coupon.discountType === 'PERCENTAGE'
      ? (orderTotal * toNum(coupon.discountValue)) / 100
      : toNum(coupon.discountValue);

    res.json({
      valid: true,
      coupon: {
        code: coupon.code,
        discountType: coupon.discountType,
        discountValue: toNum(coupon.discountValue),
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
  const parsed = CouponCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid coupon data', details: parsed.error.flatten() },
    });
    return;
  }

  try {
    const coupon = await prisma.coupon.create({
      data: {
        code: parsed.data.code,
        discountType: parsed.data.discountType,
        discountValue: parsed.data.discountValue,
        minOrderAmount: parsed.data.minOrderAmount,
        expiryDate: parsed.data.expiryDate,
        usageLimit: parsed.data.usageLimit,
        usageCount: 0,
        isActive: true,
      },
    });

    res.status(201).json({ success: true, data: coupon });
  } catch (error: any) {
    if (error.code === 'P2002') {
      res.status(409).json({
        success: false,
        error: { code: 'INVENTORY_CONFLICT', message: 'A coupon with this code already exists' },
      });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create coupon' } });
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
