import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { requireAdmin, requireRole } from '../middleware/auth';
import { ApiError } from '../lib/ApiError';

const router = Router();
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_BYTES,
  },
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, WEBP, and GIF images are allowed'));
    }
  },
});

function hasValidImageSignature(buffer: Buffer, mimetype: string): boolean {
  if (mimetype === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimetype === 'image/png') {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimetype === 'image/gif') {
    return buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'));
  }
  if (mimetype === 'image/webp') {
    return buffer.length >= 12
      && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

function getCloudinary() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw ApiError.internal('Cloudinary media storage service is not fully configured.');
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });

  return cloudinary;
}

function uploadBufferToCloudinary(fileBuffer: Buffer, mimetype: string): Promise<any> {
  return new Promise((resolve, reject) => {
    try {
      const c = getCloudinary();
      const uploadStream = c.uploader.upload_stream(
        {
          folder: 'gem-and-crystal/products',
          resource_type: 'image',
          allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
          transformation: [
            { quality: 'auto', fetch_format: 'auto' },
          ],
        },
        (error, result) => {
          if (error) return reject(error);
          resolve(result);
        }
      );

      uploadStream.end(fileBuffer);
    } catch (err) {
      reject(err);
    }
  });
}

// ── POST /api/upload/images ───────────────────────────────────────────────
router.post('/images', requireAdmin, requireRole('OWNER'), upload.array('images', 8), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      throw ApiError.badRequest('No image files provided for upload', 'BAD_REQUEST');
    }

    if (files.some(file => !hasValidImageSignature(file.buffer, file.mimetype))) {
      throw ApiError.badRequest('One or more files do not match the allowed image formats', 'BAD_REQUEST');
    }

    const uploadPromises = files.map(file => uploadBufferToCloudinary(file.buffer, file.mimetype));
    const results = await Promise.all(uploadPromises);

    const urls = results.map(r => r.secure_url).filter(Boolean);
    if (urls.length === 0) {
      throw new ApiError(500, 'MEDIA_UPLOAD_FAILED', 'Failed to generate secure image URLs.');
    }

    res.json({
      success: true,
      count: urls.length,
      urls,
      images: results.map(r => ({
        url: r.secure_url,
        public_id: r.public_id,
        format: r.format,
        width: r.width,
        height: r.height,
        bytes: r.bytes,
      })),
    });
  } catch (error: any) {
    console.error('[CLOUDINARY UPLOAD FAILURE]:', error.message || error);
    next(ApiError.badRequest('Image upload failed. Please verify file format and size.', 'MEDIA_UPLOAD_FAILED'));
  }
});

export default router;
