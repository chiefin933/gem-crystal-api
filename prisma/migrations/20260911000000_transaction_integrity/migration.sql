-- AlterTable
ALTER TABLE "Admin" ALTER COLUMN "pinCode" SET DEFAULT '';

-- AlterTable
ALTER TABLE "Coupon" ALTER COLUMN "discountValue" SET DATA TYPE DECIMAL(10,2),
ALTER COLUMN "minOrderAmount" SET DATA TYPE DECIMAL(10,2);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "mpesaIdempotencyKey" TEXT,
ADD COLUMN     "paymentExpiresAt" TIMESTAMP(3),
ALTER COLUMN "subtotal" SET DATA TYPE DECIMAL(10,2),
ALTER COLUMN "discount" SET DATA TYPE DECIMAL(10,2),
ALTER COLUMN "deliveryFee" SET DATA TYPE DECIMAL(10,2),
ALTER COLUMN "total" SET DATA TYPE DECIMAL(10,2);

-- AlterTable
ALTER TABLE "PaymentNotification" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(10,2);

-- AlterTable
ALTER TABLE "PosSale" ADD COLUMN     "cashierId" TEXT,
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "deviceId" TEXT,
ADD COLUMN     "mpesaIdempotencyKey" TEXT,
ADD COLUMN     "paymentExpiresAt" TIMESTAMP(3),
ADD COLUMN     "saleStatus" TEXT NOT NULL DEFAULT 'OPEN',
ADD COLUMN     "sessionId" TEXT,
ALTER COLUMN "subtotal" SET DATA TYPE DECIMAL(10,2),
ALTER COLUMN "discount" SET DATA TYPE DECIMAL(10,2),
ALTER COLUMN "total" SET DATA TYPE DECIMAL(10,2),
ALTER COLUMN "cashReceived" SET DATA TYPE DECIMAL(10,2),
ALTER COLUMN "changeGiven" SET DATA TYPE DECIMAL(10,2);

-- AlterTable
ALTER TABLE "Product" ALTER COLUMN "price" SET DATA TYPE DECIMAL(10,2),
ALTER COLUMN "salePrice" SET DATA TYPE DECIMAL(10,2);

-- AlterTable
ALTER TABLE "StoreSettings" ADD COLUMN     "deliveryFeeKes" INTEGER NOT NULL DEFAULT 350,
ADD COLUMN     "freeDeliveryThresholdKes" INTEGER NOT NULL DEFAULT 10000;

-- AlterTable
ALTER TABLE "Variant" ALTER COLUMN "price" SET DATA TYPE DECIMAL(10,2),
ALTER COLUMN "salePrice" SET DATA TYPE DECIMAL(10,2);

-- CreateTable
CREATE TABLE "UnmatchedPayment" (
    "id" TEXT NOT NULL,
    "mpesaReceipt" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "phone" TEXT NOT NULL,
    "payerName" TEXT,
    "rawPayload" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolutionNote" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNMATCHED',

    CONSTRAINT "UnmatchedPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UnmatchedPayment_mpesaReceipt_key" ON "UnmatchedPayment"("mpesaReceipt");

-- CreateIndex
CREATE INDEX "UnmatchedPayment_status_receivedAt_idx" ON "UnmatchedPayment"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_mpesaIdempotencyKey_key" ON "Order"("mpesaIdempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PosSale_mpesaIdempotencyKey_key" ON "PosSale"("mpesaIdempotencyKey");

-- CreateIndex
CREATE INDEX "PosSale_cashierId_createdAt_idx" ON "PosSale"("cashierId", "createdAt");

-- CreateIndex
CREATE INDEX "PosSale_sessionId_paymentStatus_idx" ON "PosSale"("sessionId", "paymentStatus");

-- CreateIndex
CREATE INDEX "PosSale_saleStatus_createdAt_idx" ON "PosSale"("saleStatus", "createdAt");


-- F3: PaymentNotification ownership constraint
-- Exactly one of orderId or posSaleId must be non-null.
-- This prevents orphaned notifications with no owner.
ALTER TABLE "PaymentNotification"
  ADD CONSTRAINT "payment_notification_ownership_check"
  CHECK (
    ("orderId" IS NOT NULL AND "posSaleId" IS NULL) OR
    ("orderId" IS NULL AND "posSaleId" IS NOT NULL)
  );

-- Create indexes added by schema changes
CREATE INDEX IF NOT EXISTS "PosSale_sessionId_paymentStatus_idx" ON "PosSale"("sessionId", "paymentStatus");
