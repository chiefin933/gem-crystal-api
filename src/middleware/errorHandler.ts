import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../lib/ApiError';

export const errorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Log detailed technical error to server console/logs
  console.error(`[API ERROR] ${req.method} ${req.path}:`, {
    name: err.name,
    message: err.message,
    code: err.code,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });

  // Handle Known Custom ApiErrors
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  // Handle Prisma Known Errors (e.g. Unique constraint violation, record not found)
  if (err.code === 'P2002') {
    return res.status(409).json({
      success: false,
      error: {
        code: 'INVENTORY_CONFLICT',
        message: 'A record with this unique identifier already exists.',
      },
    });
  }

  if (err.code === 'P2025') {
    return res.status(404).json({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'The requested record could not be found.',
      },
    });
  }

  // Default fallback for unhandled 500 errors
  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Something went wrong. Please try again or contact Gem & Crystal support.',
    },
  });
};
