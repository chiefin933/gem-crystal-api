-- Record the moment a website payment becomes final. The owner dashboard uses
-- this timestamp for Nairobi calendar-day revenue, never order creation time.
ALTER TABLE "Order" ADD COLUMN "paidAt" TIMESTAMP(3);

-- Historical records predate this field, so their original creation time is
-- retained as the only conservative, non-invented ordering fallback.
UPDATE "Order"
SET "paidAt" = "createdAt"
WHERE "paymentStatus" = 'PAID' AND "paidAt" IS NULL;

CREATE INDEX "Order_paymentStatus_paidAt_idx" ON "Order"("paymentStatus", "paidAt");
