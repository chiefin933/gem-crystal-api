-- Nullable for existing payment intents. Legacy sessions remain owner-reconcilable.
ALTER TABLE "CheckoutSession" ADD COLUMN "trackingTokenHash" TEXT;
