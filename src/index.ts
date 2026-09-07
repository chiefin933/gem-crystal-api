import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { prisma } from './lib/prisma';

import productsRouter from './routes/products';
import ordersRouter from './routes/orders';
import couponsRouter from './routes/coupons';
import adminRouter from './routes/admin';
import settingsRouter from './routes/settings';
import posRouter from './routes/pos';
import uploadRouter from './routes/upload';
import aiRouter from './routes/ai';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 4000;
app.disable('x-powered-by');

// ── Security & Performance Middleware ─────────────────────────────────────
app.use(helmet());
app.use(compression());

const configuredOrigins = [
  process.env.STOREFRONT_URL,
  process.env.ADMIN_URL,
  process.env.POS_URL,
].filter((origin): origin is string => Boolean(origin));

const allowedOrigins = new Set(
  process.env.NODE_ENV === 'production'
    ? configuredOrigins
    : [...configuredOrigins, 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'],
);

if (process.env.NODE_ENV === 'production' && allowedOrigins.size === 0) {
  throw new Error('Configure STOREFRONT_URL, ADMIN_URL, and POS_URL before starting the production API.');
}

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS origin not allowed: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-POS-Poll-Token', 'X-Order-Tracking-Token'],
  maxAge: 600,
}));

// Rate limiting for login endpoint
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many login attempts, please try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many checkout attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// AI chat: 20 requests per 5 minutes per IP — keeps costs controlled
// and prevents abuse while allowing normal conversation flow.
const aiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  message: {
    success: false,
    error: {
      code: 'AI_RATE_LIMITED',
      message: 'Too many messages. Please wait a moment before continuing.',
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '16kb', parameterLimit: 100 }));

// ── Routes ─────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), service: 'Gem & Crystal API v1' });
});

app.use('/api/products', productsRouter);
app.use('/api/orders', checkoutLimiter);
app.use('/api/orders', ordersRouter);
app.use('/api/coupons', couponsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/pos', posRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/ai', aiLimiter);
app.use('/api/ai', aiRouter);
app.use('/api/admin/login', loginLimiter);
app.use('/api/admin', adminRouter);

// ── 404 Handler ────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

import { errorHandler } from './middleware/errorHandler';

// ── Centralized Error Handler Middleware ────────────────────────────────────
app.use(errorHandler);

// ── Start Server ───────────────────────────────────────────────────────────
async function start() {
  try {
    await prisma.$connect();
    console.log('✅ Database connected');

    const server = app.listen(PORT, () => {
      console.log('');
      console.log('🚀 Gem & Crystal API running!');
      console.log(`   http://localhost:${PORT}/api/health`);
      console.log('');
    });

    server.requestTimeout = 30_000;
    server.headersTimeout = 35_000;
    server.keepAliveTimeout = 5_000;
    server.on('error', error => {
      console.error('❌ HTTP server error:', error);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

start();
