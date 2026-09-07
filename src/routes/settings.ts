import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { requireAdmin, requireRole, AuthRequest } from '../middleware/auth';

const router = Router();

// ── GET /api/settings ─────────────────────────────────────────────────────
// Public: get store configuration (WhatsApp number, location, delivery disclaimer)
router.get('/', async (_req: Request, res: Response) => {
  try {
    let settings = await prisma.storeSettings.findUnique({ where: { id: 'default' } });

    if (!settings) {
      settings = await prisma.storeSettings.create({
        data: {
          id: 'default',
          storeName: 'Gem & Crystal Fashion Hub',
          tagline: 'BE BOLD. BE BRIGHT. BE YOU.',
          location: 'Roysambu, Nairobi, Kenya',
          phone: '+254 700 123 456',
          whatsappNumber: '254700123456',
          deliveryFeeDisclaimer: 'Delivery fee is paid separately by the customer and is not included in the product order total unless otherwise stated by the shop.',
          aiChatEnabled: true,
        },
      });
    }

    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// ── PUT /api/settings ─────────────────────────────────────────────────────
// Admin: update store configuration
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
