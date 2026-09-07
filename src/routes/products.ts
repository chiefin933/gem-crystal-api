import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { requireAdmin, requireRole, AuthRequest } from '../middleware/auth';
import { ApiError } from '../lib/ApiError';
import { z } from 'zod';

const router = Router();

// Helper: parse JSON fields back to JS objects/arrays
function parseProduct(p: any) {
  return {
    ...p,
    images: JSON.parse(p.images || '[]'),
    sizes: JSON.parse(p.sizes || '[]'),
    colors: JSON.parse(p.colors || '[]'),
  };
}

// ── GET /api/products ─────────────────────────────────────────────────────
// Public endpoint: list products with optional filtering
router.get('/', async (req: Request, res: Response) => {
  try {
    const {
      gender,
      category,
      search,
      minPrice,
      maxPrice,
      onSale,
      inStock,
      sortBy,
    } = req.query;

    const where: any = { isActive: true };

    if (gender && gender !== 'all') where.gender = gender as string;
    if (category && category !== 'All') where.category = category as string;
    if (onSale === 'true') where.onSale = true;
    if (search) {
      where.OR = [
        { title: { contains: search as string } },
        { category: { contains: search as string } },
        { description: { contains: search as string } },
      ];
    }

    let priceWhere: any = {};
    if (minPrice) priceWhere.gte = Number(minPrice);
    if (maxPrice) priceWhere.lte = Number(maxPrice);
    if (Object.keys(priceWhere).length > 0) where.price = priceWhere;

    let orderBy: any = {};
    switch (sortBy) {
      case 'price-low':   orderBy = { price: 'asc' }; break;
      case 'price-high':  orderBy = { price: 'desc' }; break;
      case 'newest':      orderBy = { createdAt: 'desc' }; break;
      case 'bestselling': orderBy = { reviewCount: 'desc' }; break;
      default:            orderBy = { isFeatured: 'desc' }; break;
    }

    let products = await prisma.product.findMany({
      where,
      orderBy,
      include: { variants: true },
    });

    // inStock filter: at least one variant has stockQuantity > 0
    if (inStock === 'true') {
      products = products.filter(p =>
        p.variants.some(v => v.stockQuantity > 0)
      );
    }

    res.json(products.map(parseProduct));
  } catch (error) {
    console.error('GET /products error:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// ── GET /api/products/:id ─────────────────────────────────────────────────
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const product = await prisma.product.findFirst({
      where: {
        OR: [{ id: req.params.id }, { slug: req.params.id }],
        isActive: true,
      },
      include: { variants: true },
    });

    if (!product) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }
    res.json(parseProduct(product));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

const ProductSchema = z.object({
  title: z.string().min(2),
  gender: z.enum(['women', 'men', 'unisex']),
  category: z.string().min(1),
  price: z.number().positive(),
  salePrice: z.number().positive().optional(),
  description: z.string().default(''),
  fabricCare: z.string().default('Premium material blend. Hand wash or dry clean recommended.'),
  images: z.array(z.string().url()).min(1),
  sizes: z.array(z.string()).min(1),
  colors: z.array(z.object({ name: z.string(), hex: z.string() })).min(1),
  isNew: z.boolean().default(false),
  isBestSeller: z.boolean().default(false),
  isFeatured: z.boolean().default(false),
  stockPerVariant: z.number().int().positive().default(10),
});

// ── POST /api/admin/products ──────────────────────────────────────────────
// Admin: create a new product
router.post('/', requireAdmin, requireRole('OWNER'), async (req: AuthRequest, res: Response) => {
  try {
    const parsed = ProductSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const data = parsed.data;
    const slug = data.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now();
    const onSale = data.salePrice !== undefined && data.salePrice < data.price;

    const product = await prisma.product.create({
      data: {
        title: data.title,
        slug,
        gender: data.gender,
        category: data.category,
        subcategory: data.category,
        price: data.price,
        salePrice: data.salePrice ?? null,
        onSale,
        isNew: data.isNew,
        isBestSeller: data.isBestSeller,
        isFeatured: data.isFeatured,
        description: data.description,
        fabricCare: data.fabricCare,
        images: JSON.stringify(data.images),
        sizes: JSON.stringify(data.sizes),
        colors: JSON.stringify(data.colors),
        isActive: true,
        variants: {
          create: data.sizes.flatMap(size =>
            data.colors.map(color => ({
              sku: `${slug.toUpperCase().substring(0, 8)}-${size}-${color.name.substring(0, 3).toUpperCase()}`.replace(/[^A-Z0-9-]/g, '') + '-' + Date.now(),
              size,
              color: color.name,
              price: data.salePrice ?? data.price,
              salePrice: data.salePrice ?? null,
              stockQuantity: data.stockPerVariant,
            }))
          ),
        },
      },
      include: { variants: true },
    });

    res.status(201).json(parseProduct(product));
  } catch (error) {
    console.error('POST /products error:', error);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

const UpdateProductSchema = z.object({
  title: z.string().min(2).optional(),
  gender: z.enum(['women', 'men', 'unisex']).optional(),
  category: z.string().min(1).optional(),
  price: z.number().positive('Price must be positive').optional(),
  salePrice: z.number().positive('Sale price must be positive').nullable().optional(),
  description: z.string().optional(),
  fabricCare: z.string().optional(),
  images: z.array(z.string().url('Each image must be a valid URL')).min(1).optional(),
  sizes: z.array(z.string()).min(1).optional(),
  colors: z.array(z.object({ name: z.string(), hex: z.string() })).min(1).optional(),
  isNew: z.boolean().optional(),
  isBestSeller: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  isActive: z.boolean().optional(),
}).refine(
  (d) => d.salePrice == null || d.price == null || d.salePrice < d.price,
  { message: 'salePrice must be less than price', path: ['salePrice'] },
);

// ── PUT /api/admin/products/:id ───────────────────────────────────────────
// Admin: update a product
router.put('/:id', requireAdmin, requireRole('OWNER'), async (req: AuthRequest, res: Response) => {
  const parsed = UpdateProductSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid product data', details: parsed.error.flatten() },
    });
    return;
  }

  try {
    const data = parsed.data;
    const onSale =
      data.salePrice !== undefined && data.salePrice !== null
        ? data.salePrice < (data.price ?? 0)
        : undefined;

    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        ...(data.title       !== undefined && { title: data.title }),
        ...(data.gender      !== undefined && { gender: data.gender }),
        ...(data.category    !== undefined && { category: data.category, subcategory: data.category }),
        ...(data.price       !== undefined && { price: data.price }),
        ...(data.salePrice   !== undefined && { salePrice: data.salePrice }),
        ...(onSale           !== undefined && { onSale }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.fabricCare  !== undefined && { fabricCare: data.fabricCare }),
        ...(data.images      !== undefined && { images: JSON.stringify(data.images) }),
        ...(data.sizes       !== undefined && { sizes: JSON.stringify(data.sizes) }),
        ...(data.colors      !== undefined && { colors: JSON.stringify(data.colors) }),
        ...(data.isNew       !== undefined && { isNew: data.isNew }),
        ...(data.isBestSeller !== undefined && { isBestSeller: data.isBestSeller }),
        ...(data.isFeatured  !== undefined && { isFeatured: data.isFeatured }),
        ...(data.isActive    !== undefined && { isActive: data.isActive }),
      },
      include: { variants: true },
    });

    res.json({ success: true, data: parseProduct(product) });
  } catch (error) {
    throw ApiError.internal('Failed to update product');
  }
});

// ── DELETE /api/admin/products/:id ────────────────────────────────────────
// Admin: soft-delete a product
router.delete('/:id', requireAdmin, requireRole('OWNER'), async (req: AuthRequest, res: Response) => {
  try {
    await prisma.product.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// ── PATCH /api/products/variant/stock ────────────────────────────────────
// Admin: atomically adjust variant stock with full audit trail.
// This route MUST be declared before /:id routes so Express doesn't eat
// "variant" as a product id.
const StockAdjustmentSchema = z.object({
  variantId: z.string().min(1, 'variantId is required'),
  delta: z
    .number()
    .int('delta must be an integer')
    .refine(v => v !== 0, { message: 'delta must not be zero' })
    .refine(v => Math.abs(v) <= 10_000, { message: 'delta exceeds maximum adjustment of 10,000' }),
  reason: z.string().min(2, 'reason is required').max(200),
});

router.patch('/variant/stock', requireAdmin, requireRole('OWNER'), async (req: AuthRequest, res: Response) => {
  const parsed = StockAdjustmentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid adjustment payload', details: parsed.error.flatten() },
    });
    return;
  }

  const { variantId, delta, reason } = parsed.data;
  const actor = req.adminEmail ?? req.adminId ?? 'unknown';
  const ipAddress = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    ?? req.socket.remoteAddress
    ?? 'unknown';

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Lock the row and read current stock inside the transaction
      const variant = await tx.variant.findUnique({ where: { id: variantId } });
      if (!variant) throw new ApiError(404, 'NOT_FOUND', 'Variant not found');

      const previousStock = variant.stockQuantity;
      const newStock = Math.max(0, previousStock + delta);
      const actualDelta = newStock - previousStock; // may differ from delta if clamped at 0

      // Atomic stock update
      const updated = await tx.variant.update({
        where: { id: variantId },
        data: { stockQuantity: newStock },
      });

      // Record every movement for accountability
      await (tx as any).inventoryMovement.create({
        data: {
          variantId,
          type: 'ADJUSTMENT',
          quantity: actualDelta,
          previousStock,
          newStock,
          reason,
          referenceType: 'MANUAL',
          actor,
        },
      });

      // Full audit trail so the owner can trace who changed what
      await (tx as any).auditLog.create({
        data: {
          actor,
          action: 'INVENTORY_ADJUSTED',
          details: JSON.stringify({
            variantId,
            sku: variant.sku,
            previousStock,
            requestedDelta: delta,
            actualDelta,
            newStock,
            reason,
          }),
          ipAddress,
        },
      });

      return updated;
    });

    res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw ApiError.internal('Failed to adjust stock');
  }
});

export default router;
