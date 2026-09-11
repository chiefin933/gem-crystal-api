import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { requireAdmin, requireRole, AuthRequest } from '../middleware/auth';

const router = Router();

// ── GET /api/settings ─────────────────────────────────────────────────────
// Public: returns store configuration. Read-only — never mutates the DB.
// The settings record must be created by the seed/init script before the
// server starts. If it is missing, return sensible defaults so the storefront
// never crashes, but do NOT create it here — a GET must stay idempotent.
router.get('/', async (_req: Request, res: Response) => {
  try {
    const settings = await prisma.storeSettings.findUnique({ where: { id: 'default' } });

    if (!settings) {
      // Record missing — return safe read-only defaults without writing.
      // Run `npm run setup:dev` or `npm run db:seed:dev` to initialise.
      res.json({
        id: 'default',
        storeName: 'Gem & Crystal Fashion Hub',
        tagline: 'BE BOLD. BE BRIGHT. BE YOU.',
        location: 'Roysambu, Nairobi, Kenya',
        phone: '+254 718 796 296',
        whatsappNumber: '254718796296',
        deliveryFeeDisclaimer: 'Delivery fee is paid separately by the customer and is not included in the product order total unless otherwise stated by the shop.',
        deliveryFeeKes: 350,
        freeDeliveryThresholdKes: 10000,
        aiChatEnabled: true,
      });
      return;
    }

    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// ── PUT /api/settings ─────────────────────────────────────────────────────
// Admin: update store configuration.
router.put('/', requireAdmin, requireRole('OWNER'), async (req: AuthRequest, res: Response) => {
  try {
    const { storeName, tagline, location, phone, whatsappNumber, deliveryFeeDisclaimer, aiChatEnabled } = req.body;

    const settings = await prisma.storeSettings.upsert({
      where: { id: 'default' },
      update: {
        storeName,
        tagline,
        location,
        phone,
        whatsappNumber,
        deliveryFeeDisclaimer,
        aiChatEnabled,
      },
      create: {
        id: 'default',
        storeName,
        tagline,
        location,
        phone,
        whatsappNumber,
        deliveryFeeDisclaimer,
        aiChatEnabled,
      },
    });

    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

export default router;
