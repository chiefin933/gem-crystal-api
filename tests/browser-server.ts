// Disposable local browser fixture. No live provider calls or production DB access.
import express from 'express';
import cors from 'cors';
async function main() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || new URL(url).hostname !== '127.0.0.1' || !new URL(url).pathname.includes('tests')) throw new Error('Disposable TEST_DATABASE_URL required');
  Object.assign(process.env, { DATABASE_URL: url, JWT_SECRET: 'browser-fixture-only', AI_API_KEY: '', MPESA_CONSUMER_KEY: 'test', MPESA_CONSUMER_SECRET: 'test', MPESA_SHORTCODE: '600000', MPESA_TILL_NUMBER: '123456', MPESA_C2B_CALLBACK_SECRET: 'test-callback-secret', MPESA_C2B_CALLBACK_URL: 'https://example.test/api/orders/c2b-callback' });
  const { prisma } = await import('../src/lib/prisma');
  await prisma.product.upsert({ where: { slug: 'browser-test-dress' }, update: {}, create: {
    id: 'browser-product', slug: 'browser-test-dress', title: 'Browser Test Dress', gender: 'women', category: 'Dresses', subcategory: '', price: 100,
    images: '["/src/assets/hero.png"]', isFeatured: true, sizes: '["M"]', colors: '[{"name":"Black","hex":"#000000"}]', variants: { create: { id: 'browser-variant', sku: 'browser-sku', size: 'M', color: 'Black', price: 100, stockQuantity: 10 } },
  } });
  const app = express(); app.use(cors()); app.use(express.json());
  app.use('/api/products', (await import('../src/routes/products')).default);
  app.use('/api/settings', (await import('../src/routes/settings')).default);
  app.use('/api/orders', (await import('../src/routes/orders')).default);
  app.use('/api/ai', (await import('../src/routes/ai')).default);
  app.use((await import('../src/middleware/errorHandler')).errorHandler);
  app.listen(55440, '127.0.0.1', () => console.log('Disposable browser API on 55440'));
}
void main();
