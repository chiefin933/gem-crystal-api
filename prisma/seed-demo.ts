import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type DemoProduct = {
  title: string;
  slug: string;
  gender: string;
  category: string;
  price: number;
  salePrice?: number;
  description: string;
  images: string[];
  sizes: string[];
  colors: { name: string; hex: string }[];
  variants: { sku: string; size: string; color: string; price: number; salePrice?: number; stockQuantity: number }[];
};

const products: DemoProduct[] = [
  {
    title: 'Rose Tailored Blazer',
    slug: 'demo-rose-tailored-blazer',
    gender: 'women',
    category: 'Crop jackets',
    price: 6490,
    salePrice: 5490,
    description: 'Demo tailored blazer for safe storefront and checkout testing.',
    images: ['https://images.unsplash.com/photo-1591369822096-ffd140ec948f?auto=format&fit=crop&w=900&q=80'],
    sizes: ['S', 'M', 'L'],
    colors: [{ name: 'Rose', hex: '#E11D48' }, { name: 'Black', hex: '#18181B' }],
    variants: [
      { sku: 'DEMO-BLAZER-S-ROSE', size: 'S', color: 'Rose', price: 5490, salePrice: 5490, stockQuantity: 8 },
      { sku: 'DEMO-BLAZER-M-ROSE', size: 'M', color: 'Rose', price: 5490, salePrice: 5490, stockQuantity: 8 },
      { sku: 'DEMO-BLAZER-L-BLACK', size: 'L', color: 'Black', price: 5490, salePrice: 5490, stockQuantity: 5 },
    ],
  },
  {
    title: 'Midnight Straight Jeans',
    slug: 'demo-midnight-straight-jeans',
    gender: 'unisex',
    category: 'Straight jeans',
    price: 4290,
    description: 'Demo premium denim for checkout and inventory testing.',
    images: ['https://images.unsplash.com/photo-1542272604-787c3835535d?auto=format&fit=crop&w=900&q=80'],
    sizes: ['30', '32', '34'],
    colors: [{ name: 'Indigo', hex: '#1E3A5F' }],
    variants: [
      { sku: 'DEMO-JEANS-30-INDIGO', size: '30', color: 'Indigo', price: 4290, stockQuantity: 10 },
      { sku: 'DEMO-JEANS-32-INDIGO', size: '32', color: 'Indigo', price: 4290, stockQuantity: 10 },
      { sku: 'DEMO-JEANS-34-INDIGO', size: '34', color: 'Indigo', price: 4290, stockQuantity: 6 },
    ],
  },
  {
    title: 'Sandbox Test Item — KES 1',
    slug: 'sandbox-test-item-kes-1',
    gender: 'unisex',
    category: 'Sandbox testing',
    price: 1,
    description: 'A separate KES 1 item for Daraja sandbox payment testing only.',
    images: ['https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?auto=format&fit=crop&w=900&q=80'],
    sizes: ['One size'],
    colors: [{ name: 'Test', hex: '#16A34A' }],
    variants: [
      { sku: 'SANDBOX-KES-1', size: 'One size', color: 'Test', price: 1, stockQuantity: 25 },
    ],
  },
];

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to load demo records in production');
  }

  for (const item of products) {
    const product = await prisma.product.upsert({
      where: { slug: item.slug },
      update: {
        title: item.title,
        gender: item.gender,
        category: item.category,
        subcategory: item.category,
        price: item.price,
        salePrice: item.salePrice ?? null,
        onSale: Boolean(item.salePrice),
        isNew: item.slug === 'demo-rose-tailored-blazer',
        isBestSeller: item.slug === 'demo-midnight-straight-jeans',
        isFeatured: item.slug === 'demo-rose-tailored-blazer',
        description: item.description,
        images: JSON.stringify(item.images),
        sizes: JSON.stringify(item.sizes),
        colors: JSON.stringify(item.colors),
        isActive: true,
      },
      create: {
        title: item.title,
        slug: item.slug,
        gender: item.gender,
        category: item.category,
        subcategory: item.category,
        price: item.price,
        salePrice: item.salePrice ?? null,
        onSale: Boolean(item.salePrice),
        isNew: item.slug === 'demo-rose-tailored-blazer',
        isBestSeller: item.slug === 'demo-midnight-straight-jeans',
        isFeatured: item.slug === 'demo-rose-tailored-blazer',
        description: item.description,
        images: JSON.stringify(item.images),
        sizes: JSON.stringify(item.sizes),
  await prisma.product.updateMany({
    where: { slug: { in: ['demo-rose-tailored-blazer', 'demo-midnight-straight-jeans'] } },
    data: { isActive: false },
  });
        colors: JSON.stringify(item.colors),
      },
    });

    for (const variant of item.variants) {
      await prisma.variant.upsert({
        where: { sku: variant.sku },
        update: {
          productId: product.id,
          size: variant.size,
          color: variant.color,
          price: variant.price,
          salePrice: variant.salePrice ?? null,
          stockQuantity: variant.stockQuantity,
        },
        create: { productId: product.id, ...variant },
      });
    }
  }

  await prisma.coupon.upsert({
    where: { code: 'WELCOME10' },
    update: {},
    create: {
      code: 'WELCOME10',
      discountType: 'PERCENTAGE',
      discountValue: 10,
      minOrderAmount: 3000,
      expiryDate: '2030-12-31',
      usageLimit: 100,
    },
  });

  await prisma.storeSettings.upsert({
    where: { id: 'default' },
    update: {},
    create: {
      id: 'default',
      storeName: 'Gem & Crystal Fashion Hub',
      tagline: 'BE BOLD. BE BRIGHT. BE YOU.',
      location: 'Roysambu, Nairobi, Kenya',
      phone: '+254 718 796 296',
      whatsappNumber: '254718796296',
    },
  });

  console.log(`Demo catalog ready: ${products.length} products, 6 variants, and coupon WELCOME10.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
