import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  // ── Production safety guard ─────────────────────────────────────────────
  // This script WIPES business data. It must never run against a production
  // database. If you need to initialise production credentials, use the
  // dedicated `npm run db:init:prod` script which only upserts the admin
  // account and store settings without touching any business records.
  if (process.env.NODE_ENV === 'production') {
    console.error('');
    console.error('❌ REFUSED: seed.ts will not run in NODE_ENV=production.');
    console.error('   This script deletes ALL products, orders, and POS sales.');
    console.error('   To initialise a fresh production database use:');
    console.error('     npm run db:migrate:deploy');
    console.error('');
    process.exit(1);
  }

  console.log('🌱 [DEV] Clearing all demo data from Gem & Crystal database...');

  // 1. Clear all demo data tables
  await prisma.variant.deleteMany({});
  await prisma.posSale.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.coupon.deleteMany({});
  console.log('✅ Deleted all demo products, variants, POS sales, orders, and coupons');

  // 2. Create/Update Credentials. Production credentials must always be
  // supplied through the deployment secret manager, never through defaults.
  const isProduction = process.env.NODE_ENV === 'production';
  const required = (name: string, demoValue: string) => {
    const value = process.env[name];
    if (isProduction && !value) {
      throw new Error(`${name} must be configured before production seeding`);
    }
    return value || demoValue;
  };

  const adminEmail = required('ADMIN_EMAIL', 'admin@gemandcrystal.co.ke');
  const adminPassword = required('ADMIN_PASSWORD', 'GemAdmin@2024');
  const passwordHash = await bcrypt.hash(adminPassword, 12);

  await prisma.admin.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      passwordHash,
      name: required('ADMIN_NAME', 'Store Owner'),
    },
  });

  await prisma.admin.upsert({
    where: { email: required('CASHIER_EMAIL', 'cashier@gemandcrystal.co.ke') },
    update: {},
    create: {
      email: required('CASHIER_EMAIL', 'cashier@gemandcrystal.co.ke'),
      passwordHash: await bcrypt.hash(required('CASHIER_PASSWORD', 'Cashier@2024'), 12),
      name: required('CASHIER_NAME', 'Cashier Grace (Roysambu)'),
      role: 'CASHIER',
      pinCode: await bcrypt.hash(required('CASHIER_PIN', '1234'), 12),
    },
  });

  // 3. Seed a small, coherent sample catalog for pre-launch visual and flow QA.
  // All prices and stock are intentionally demo values.
  await prisma.product.create({
    data: {
      title: 'Rose Tailored Blazer',
      slug: 'demo-rose-tailored-blazer',
      gender: 'women',
      category: 'Crop jackets',
      subcategory: 'Crop jackets',
      price: 6490,
      salePrice: 5490,
      onSale: true,
      isNew: true,
      isFeatured: true,
      description: 'Demo tailored blazer for pre-launch storefront testing.',
      images: JSON.stringify(['https://images.unsplash.com/photo-1591369822096-ffd140ec948f?auto=format&fit=crop&w=900&q=80']),
      sizes: JSON.stringify(['S', 'M', 'L']),
      colors: JSON.stringify([{ name: 'Rose', hex: '#E11D48' }, { name: 'Black', hex: '#18181B' }]),
      variants: {
        create: [
          { sku: 'DEMO-BLAZER-S-ROSE', size: 'S', color: 'Rose', price: 5490, salePrice: 5490, stockQuantity: 8 },
          { sku: 'DEMO-BLAZER-M-ROSE', size: 'M', color: 'Rose', price: 5490, salePrice: 5490, stockQuantity: 8 },
          { sku: 'DEMO-BLAZER-L-BLACK', size: 'L', color: 'Black', price: 5490, salePrice: 5490, stockQuantity: 5 },
        ],
      },
    },
  });

  await prisma.product.create({
    data: {
      title: 'Midnight Straight Jeans',
      slug: 'demo-midnight-straight-jeans',
      gender: 'unisex',
      category: 'Straight jeans',
      subcategory: 'Straight jeans',
      price: 4290,
      isBestSeller: true,
      description: 'Demo premium denim for checkout and inventory testing.',
      images: JSON.stringify(['https://images.unsplash.com/photo-1542272604-787c3835535d?auto=format&fit=crop&w=900&q=80']),
      sizes: JSON.stringify(['30', '32', '34']),
      colors: JSON.stringify([{ name: 'Indigo', hex: '#1E3A5F' }]),
      variants: {
        create: [
          { sku: 'DEMO-JEANS-30-INDIGO', size: '30', color: 'Indigo', price: 4290, stockQuantity: 10 },
          { sku: 'DEMO-JEANS-32-INDIGO', size: '32', color: 'Indigo', price: 4290, stockQuantity: 10 },
          { sku: 'DEMO-JEANS-34-INDIGO', size: '34', color: 'Indigo', price: 4290, stockQuantity: 6 },
        ],
      },
    },
  });

  await prisma.coupon.create({
    data: {
      code: 'WELCOME10',
      discountType: 'PERCENTAGE',
      discountValue: 10,
      minOrderAmount: 3000,
      expiryDate: '2030-12-31',
      usageLimit: 100,
    },
  });

  // 4. Create Default Store Settings
  await prisma.storeSettings.upsert({
    where: { id: 'default' },
    update: {
      phone: '+254 718 796 296',
      whatsappNumber: '254718796296',
    },
    create: {
      id: 'default',
      storeName: 'Gem & Crystal Fashion Hub',
      tagline: 'BE BOLD. BE BRIGHT. BE YOU.',
      location: 'Roysambu, Nairobi, Kenya',
      phone: '+254 718 796 296',
      whatsappNumber: '254718796296',
    },
  });

  // 5. Create Default Hardware Config
  await prisma.hardwareConfig.upsert({
    where: { id: 'pos-01' },
    update: {},
    create: {
      id: 'pos-01',
      tabletName: 'Gem & Crystal POS Tablet 01',
      status: 'IDLE',
    },
  });

  console.log(`✅ Admin account active: ${adminEmail}`);
  console.log('✅ Store settings & hardware defaults initialized');
  console.log('🎉 PostgreSQL database ready!');
}

main()
  .catch(e => {
    console.error('❌ Clean script failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
