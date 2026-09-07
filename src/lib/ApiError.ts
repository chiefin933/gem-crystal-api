export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_CREDENTIALS'
  | 'OUT_OF_STOCK'
  | 'INVENTORY_CONFLICT'
  | 'INVENTORY_ADJUSTED'
  | 'VALIDATION_ERROR'
  | 'AI_UNAVAILABLE'
  | 'AI_RATE_LIMITED'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_PENDING'
  | 'MEDIA_UPLOAD_FAILED'
  | 'HARDWARE_DISCONNECTED'
  | 'AUTH_EXPIRED'
  | 'INTERNAL_SERVER_ERROR';

export class ApiError extends Error {
  public statusCode: number;
  public code: ErrorCode;
  public details?: any;

  constructor(statusCode: number, code: ErrorCode, message: string, details?: any) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static badRequest(message: string, code: ErrorCode = 'BAD_REQUEST', details?: any) {
    return new ApiError(400, code, message, details);
  }

  static unauthorized(message: string = 'Authentication required', code: ErrorCode = 'UNAUTHORIZED') {
    return new ApiError(401, code, message);
  }

  static forbidden(message: string = 'You do not have permission to perform this action', code: ErrorCode = 'FORBIDDEN') {
    return new ApiError(403, code, message);
  }

  static notFound(message: string = 'Resource not found', code: ErrorCode = 'NOT_FOUND') {
    return new ApiError(404, code, message);
  }

  static outOfStock(message: string = 'This item is currently out of stock') {
    return new ApiError(409, 'OUT_OF_STOCK', message);
  }

  static internal(message: string = 'An unexpected error occurred. Please try again later.') {
    return new ApiError(500, 'INTERNAL_SERVER_ERROR', message);
  }
}
