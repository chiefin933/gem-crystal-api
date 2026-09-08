-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "gender" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subcategory" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "salePrice" DECIMAL(10,2),
    "onSale" BOOLEAN NOT NULL DEFAULT false,
    "isNew" BOOLEAN NOT NULL DEFAULT false,
    "isBestSeller" BOOLEAN NOT NULL DEFAULT false,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 5.0,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL DEFAULT '',
    "fabricCare" TEXT NOT NULL DEFAULT 'Premium material blend. Hand wash or dry clean recommended.',
    "images" TEXT NOT NULL DEFAULT '[]',
    "sizes" TEXT NOT NULL DEFAULT '[]',
    "colors" TEXT NOT NULL DEFAULT '[]',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Variant" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "barcode" TEXT,
    "size" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "salePrice" DECIMAL(10,2),
    "stockQuantity" INTEGER NOT NULL DEFAULT 10,

    CONSTRAINT "Variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL DEFAULT '',
    "customerPhone" TEXT NOT NULL,
    "customerCounty" TEXT NOT NULL,
    "customerTownCity" TEXT NOT NULL,
    "customerAddress" TEXT NOT NULL,
    "customerNotes" TEXT NOT NULL DEFAULT '',
    "items" TEXT NOT NULL,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "discount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "couponCode" TEXT,
    "deliveryFee" DECIMAL(10,2) NOT NULL DEFAULT 350,
    "total" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "paymentMethod" TEXT NOT NULL,
    "paymentStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "fulfillmentStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "mpesaPhone" TEXT,
    "mpesaReceipt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trackingTokenHash" TEXT NOT NULL,
    "mpesaIdempotencyKey" TEXT,
    "mpesaCheckoutRequestId" TEXT,
    "mpesaInitiatedAt" TIMESTAMP(3),
    "mpesaMerchantRequestId" TEXT,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentNotification" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "paymentMethod" TEXT NOT NULL DEFAULT 'MPESA',
    "mpesaReceipt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "paymentReference" TEXT NOT NULL,
    "posSaleId" TEXT,

    CONSTRAINT "PaymentNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Coupon" (
    "code" TEXT NOT NULL,
    "discountType" TEXT NOT NULL,
    "discountValue" DECIMAL(10,2) NOT NULL,
    "minOrderAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "expiryDate" TEXT NOT NULL,
    "usageLimit" INTEGER NOT NULL DEFAULT 100,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "Admin" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'OWNER',
    "pinCode" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Admin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "storeName" TEXT NOT NULL DEFAULT 'Gem & Crystal Fashion Hub',
    "tagline" TEXT NOT NULL DEFAULT 'BE BOLD. BE BRIGHT. BE YOU.',
    "location" TEXT NOT NULL DEFAULT 'Roysambu, Nairobi, Kenya',
    "phone" TEXT NOT NULL DEFAULT '+254 718 796 296',
    "whatsappNumber" TEXT NOT NULL DEFAULT '254718796296',
    "deliveryFeeDisclaimer" TEXT NOT NULL DEFAULT 'Delivery fee is paid separately by the customer and is not included in the product order total unless otherwise stated by the shop.',
    "aiChatEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosLoginRequest" (
    "id" TEXT NOT NULL,
    "cashierId" TEXT NOT NULL,
    "cashierName" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "biometricId" TEXT,
    "pollTokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosLoginRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosSession" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "cashierId" TEXT NOT NULL,
    "cashierName" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "sessionTokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "startTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3),

    CONSTRAINT "PosSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosSale" (
    "id" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "cashierName" TEXT NOT NULL,
    "customerName" TEXT NOT NULL DEFAULT 'Walk-in Customer',
    "customerPhone" TEXT,
    "mpesaReceipt" TEXT,
    "items" TEXT NOT NULL,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "discount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(10,2) NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "cashReceived" DECIMAL(10,2),
    "changeGiven" DECIMAL(10,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mpesaIdempotencyKey" TEXT,
    "mpesaCheckoutRequestId" TEXT,
    "mpesaInitiatedAt" TIMESTAMP(3),
    "mpesaMerchantRequestId" TEXT,
    "paymentStatus" TEXT NOT NULL DEFAULT 'PAID',

    CONSTRAINT "PosSale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HardwareConfig" (
    "id" TEXT NOT NULL DEFAULT 'pos-01',
    "tabletName" TEXT NOT NULL DEFAULT 'Gem & Crystal POS Tablet 01',
    "tabletConnected" BOOLEAN NOT NULL DEFAULT false,
    "barcodeScanner" BOOLEAN NOT NULL DEFAULT false,
    "fingerprintReader" BOOLEAN NOT NULL DEFAULT false,
    "receiptPrinter" BOOLEAN NOT NULL DEFAULT false,
    "cashDrawer" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'IDLE',

    CONSTRAINT "HardwareConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryMovement" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "previousStock" INTEGER NOT NULL,
    "newStock" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "actor" TEXT NOT NULL DEFAULT 'System',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "county" TEXT,
    "city" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_slug_key" ON "Product"("slug");

-- CreateIndex
CREATE INDEX "Product_gender_category_isActive_idx" ON "Product"("gender", "category", "isActive");

-- CreateIndex
CREATE INDEX "Product_isFeatured_isNew_idx" ON "Product"("isFeatured", "isNew");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_sku_key" ON "Variant"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "Order_orderNumber_key" ON "Order"("orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Order_mpesaReceipt_key" ON "Order"("mpesaReceipt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_trackingTokenHash_key" ON "Order"("trackingTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Order_mpesaIdempotencyKey_key" ON "Order"("mpesaIdempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Order_mpesaCheckoutRequestId_key" ON "Order"("mpesaCheckoutRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_mpesaMerchantRequestId_key" ON "Order"("mpesaMerchantRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentNotification_orderId_key" ON "PaymentNotification"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentNotification_paymentReference_key" ON "PaymentNotification"("paymentReference");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentNotification_posSaleId_key" ON "PaymentNotification"("posSaleId");

-- CreateIndex
CREATE INDEX "PaymentNotification_acknowledgedAt_createdAt_idx" ON "PaymentNotification"("acknowledgedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Admin_email_key" ON "Admin"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PosLoginRequest_pollTokenHash_key" ON "PosLoginRequest"("pollTokenHash");

-- CreateIndex
CREATE INDEX "PosLoginRequest_status_expiresAt_idx" ON "PosLoginRequest"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "PosLoginRequest_cashierId_createdAt_idx" ON "PosLoginRequest"("cashierId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PosSession_requestId_key" ON "PosSession"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "PosSession_sessionTokenHash_key" ON "PosSession"("sessionTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "PosSale_receiptNumber_key" ON "PosSale"("receiptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PosSale_mpesaReceipt_key" ON "PosSale"("mpesaReceipt");

-- CreateIndex
CREATE UNIQUE INDEX "PosSale_mpesaIdempotencyKey_key" ON "PosSale"("mpesaIdempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PosSale_mpesaCheckoutRequestId_key" ON "PosSale"("mpesaCheckoutRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "PosSale_mpesaMerchantRequestId_key" ON "PosSale"("mpesaMerchantRequestId");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryMovement_variantId_createdAt_idx" ON "InventoryMovement"("variantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_phone_key" ON "Customer"("phone");

-- AddForeignKey
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentNotification" ADD CONSTRAINT "PaymentNotification_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentNotification" ADD CONSTRAINT "PaymentNotification_posSaleId_fkey" FOREIGN KEY ("posSaleId") REFERENCES "PosSale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosLoginRequest" ADD CONSTRAINT "PosLoginRequest_cashierId_fkey" FOREIGN KEY ("cashierId") REFERENCES "Admin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

