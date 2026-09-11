/**
 * Shared order/reservation helpers used by both orders.ts and pos.ts.
 * Extracted to avoid circular imports.
 */

/**
 * Restores stock for all line items in a failed/expired ecommerce order,
 * reverses coupon usage, and creates InventoryMovement records.
 * Must be called inside a Prisma transaction.
 */
export async function releaseFailedOrderReservation(tx: any, order: any, reason: string): Promise<void> {
  const items = JSON.parse(order.items) as Array<{ variantId: string; quantity: number; title: string }>;
  for (const item of items) {
    if (!item.variantId || !Number.isInteger(item.quantity) || item.quantity < 1) continue;
    const variant = await tx.variant.findUnique({ where: { id: item.variantId } });
    if (!variant) continue;
    const restored = await tx.variant.update({
      where: { id: item.variantId },
      data: { stockQuantity: { increment: item.quantity } },
      select: { stockQuantity: true },
    });
    await tx.inventoryMovement.create({
      data: {
        variantId: item.variantId,
        type: 'RETURN',
        quantity: item.quantity,
        previousStock: restored.stockQuantity - item.quantity,
        newStock: restored.stockQuantity,
        reason,
        referenceType: 'ECOM_ORDER',
        referenceId: order.orderNumber,
        actor: 'System',
      },
    });
  }

  if (order.couponCode) {
    await tx.coupon.updateMany({
      where: { code: order.couponCode, usageCount: { gt: 0 } },
      data: { usageCount: { decrement: 1 } },
    });
  }
}
