import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { prisma } from '../lib/prisma';

dotenv.config();

const JWT_SECRET: string = process.env.JWT_SECRET || '';
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is required. Set it in the API environment.');
}

// Issuer/audience constants — tokens signed by this API are only valid
// when verified with matching iss and aud claims.
const JWT_ISSUER = 'gem-crystal-api';
const JWT_AUDIENCE = 'gem-crystal-admin';

export type AdminRole = 'OWNER' | 'CASHIER';

export interface AuthRequest extends Request {
  adminId?: string;
  adminEmail?: string;
  adminRole?: AdminRole;
}

interface JwtPayload {
  adminId: string;
  email: string;
  role: AdminRole;
}

export async function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();

  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }) as unknown as JwtPayload;

    if (!decoded.adminId || !decoded.email || !decoded.role) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid authentication token' } });
      return;
    }

    const admin = await prisma.admin.findUnique({
      where: { id: decoded.adminId },
      select: { id: true, email: true, role: true },
    });

    if (!admin || admin.email !== decoded.email || !['OWNER', 'CASHIER'].includes(admin.role)) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid authentication token' } });
      return;
    }

    req.adminId = admin.id;
    req.adminEmail = admin.email;
    req.adminRole = admin.role as AdminRole;
    next();
  } catch {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
  }
}

export function requireRole(...allowedRoles: AdminRole[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.adminRole || !allowedRoles.includes(req.adminRole)) {
      res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'You do not have permission to perform this action' },
      });
      return;
    }
    next();
  };
}

export function generateToken(adminId: string, email: string, role: AdminRole): string {
  return jwt.sign({ adminId, email, role }, JWT_SECRET, {
    expiresIn: '12h',
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}
