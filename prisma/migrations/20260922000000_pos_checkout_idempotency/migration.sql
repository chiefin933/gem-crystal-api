-- Prevent a retried POS checkout from creating a second sale.
-- Existing sales receive their immutable receipt number as the legacy key.
ALTER TABLE "PosSale" ADD COLUMN "checkoutIdempotencyKey" TEXT;
UPDATE "PosSale"
SET "checkoutIdempotencyKey" = "receiptNumber"
WHERE "checkoutIdempotencyKey" IS NULL;
ALTER TABLE "PosSale" ALTER COLUMN "checkoutIdempotencyKey" SET NOT NULL;
CREATE UNIQUE INDEX "PosSale_checkoutIdempotencyKey_key"
  ON "PosSale"("checkoutIdempotencyKey");
