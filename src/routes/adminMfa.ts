import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { AuthRequest, generateToken, requireMfaSetup } from '../middleware/auth';
import {
  createMfaSetup,
  decryptMfaSecret,
  encryptMfaSecret,
  generateRecoveryCodes,
  validateTotp,
} from '../services/mfa';

const router = Router();
const MfaCodeSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/) }).strict();

// A password-verified, ten-minute setup token can only enroll MFA. It cannot
// call an owner API and becomes unusable as soon as MFA is enabled.
router.post('/setup/start', requireMfaSetup, async (req: AuthRequest, res: Response) => {
  try {
    const setup = createMfaSetup(req.adminEmail!);
    await prisma.admin.update({
      where: { id: req.adminId },
      data: {
        mfaPendingSecretEncrypted: encryptMfaSecret(setup.secret),
        mfaUpdatedAt: new Date(),
      },
    });
    res.set('Cache-Control', 'no-store').json({
      success: true,
      secret: setup.secret,
      otpauthUri: setup.otpauthUri,
      message: 'Add this account to your authenticator, then confirm a current six-digit code.',
    });
  } catch (error) {
    console.error('MFA setup start failed:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'Unable to start MFA setup.' } });
  }
});

router.post('/setup/confirm', requireMfaSetup, async (req: AuthRequest, res: Response) => {
  const parsed = MfaCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Enter a valid six-digit authenticator code.' } });
    return;
  }

  try {
    const admin = await prisma.admin.findUnique({
      where: { id: req.adminId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        mfaEnabled: true,
        mfaPendingSecretEncrypted: true,
      },
    });
    if (!admin || admin.mfaEnabled || !admin.mfaPendingSecretEncrypted) {
      res.status(409).json({ success: false, error: { code: 'MFA_SETUP_INVALID', message: 'MFA setup must be started again.' } });
      return;
    }

    const secret = decryptMfaSecret(admin.mfaPendingSecretEncrypted);
    const step = validateTotp(secret, admin.email, parsed.data.code);
    if (step == null) {
      res.status(401).json({ success: false, error: { code: 'INVALID_MFA_CODE', message: 'The authenticator code is invalid or expired.' } });
      return;
    }

    const recovery = generateRecoveryCodes();
    const updated = await prisma.admin.updateMany({
      where: { id: admin.id, mfaEnabled: false, mfaPendingSecretEncrypted: admin.mfaPendingSecretEncrypted },
      data: {
        mfaEnabled: true,
        mfaSecretEncrypted: admin.mfaPendingSecretEncrypted,
        mfaPendingSecretEncrypted: null,
        mfaRecoveryCodeHashes: JSON.stringify(recovery.hashes),
        mfaLastUsedStep: step,
        mfaUpdatedAt: new Date(),
        tokenVersion: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      res.status(409).json({ success: false, error: { code: 'MFA_SETUP_INVALID', message: 'MFA setup state changed. Start again.' } });
      return;
    }

    const securedAdmin = await prisma.admin.findUniqueOrThrow({ where: { id: admin.id } });
    const token = generateToken(securedAdmin.id, securedAdmin.email, securedAdmin.role as 'OWNER', securedAdmin.tokenVersion);
    res.set('Cache-Control', 'no-store').json({
      success: true,
      token,
      admin: { id: securedAdmin.id, email: securedAdmin.email, name: securedAdmin.name, role: securedAdmin.role, mfaEnabled: true },
      recoveryCodes: recovery.codes,
    });
  } catch (error) {
    console.error('MFA setup confirmation failed:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'Unable to confirm MFA setup.' } });
  }
});

export default router;
