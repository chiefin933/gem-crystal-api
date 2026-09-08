/**
 * Domain Event Bus — Gem & Crystal Fashion Hub
 *
 * Architecture rules:
 *   1. Events are ALWAYS emitted AFTER the database transaction commits.
 *      Never emit inside a $transaction() callback — a rollback would have
 *      already fired the event.
 *   2. Listeners must be idempotent and must not throw. A failed listener
 *      must not affect the HTTP response that already succeeded.
 *   3. Keep financial state changes synchronous and transactional.
 *      Use events only for notifications, analytics, and side effects.
 *   4. Do not add Redis/BullMQ until the synchronous event flow is proven.
 *      The EventEmitter is sufficient for Phase 1.
 */

import { EventEmitter } from 'events';

// ── Event payload types ────────────────────────────────────────────────────

export interface OrderPaidEvent {
  orderId: string;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  customerTownCity: string;
  customerCounty: string;
  total: number;
  paymentMethod: string;
  mpesaReceipt?: string | null;
  items: Array<{ title: string; size: string; color: string; quantity: number; price: number }>;
}

export interface OrderCreatedEvent {
  orderId: string;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  total: number;
  paymentMethod: string;
}

export interface OrderCancelledEvent {
  orderId: string;
  orderNumber: string;
  reason: string;
}

export interface SaleCreatedEvent {
  receiptNumber: string;
  cashierName: string;
  customerName: string;
  customerPhone?: string | null;
  total: number;
  paymentMethod: string;
  mpesaReceipt?: string | null;
  items: Array<{ title: string; size: string; color: string; quantity: number; price: number }>;
}

export interface PaymentFailedEvent {
  reference: string; // orderNumber or receiptNumber
  type: 'ORDER' | 'POS_SALE';
  reason: string;
}

export interface InventoryAdjustedEvent {
  variantId: string;
  sku: string;
  previousStock: number;
  newStock: number;
  reason: string;
  actor: string;
}

export interface InventoryDeductedEvent {
  variantId: string;
  quantity: number;
  reference: string;
  actor: string;
}

// ── Event name map (typed keys prevent string typos) ──────────────────────
export interface DomainEvents {
  OrderCreated:       OrderCreatedEvent;
  OrderPaid:          OrderPaidEvent;
  OrderCancelled:     OrderCancelledEvent;
  SaleCreated:        SaleCreatedEvent;
  PaymentFailed:      PaymentFailedEvent;
  InventoryAdjusted:  InventoryAdjustedEvent;
  InventoryDeducted:  InventoryDeductedEvent;
}

// ── Typed EventEmitter ─────────────────────────────────────────────────────
class DomainEventBus extends EventEmitter {
  emit<K extends keyof DomainEvents>(event: K, payload: DomainEvents[K]): boolean {
    return super.emit(event as string, payload);
  }

  on<K extends keyof DomainEvents>(event: K, listener: (payload: DomainEvents[K]) => void): this {
    return super.on(event as string, listener);
  }
}

export const eventBus = new DomainEventBus();

// ── Listeners ──────────────────────────────────────────────────────────────
// Phase 1: structured logging. Each listener is wrapped in try/catch so a
// listener failure never propagates back to the caller.

eventBus.on('OrderCreated', (e) => {
  try {
    console.log(`[EVENT] OrderCreated  #${e.orderNumber}  ${e.paymentMethod}  KES ${e.total}`);
  } catch {}
});

eventBus.on('OrderPaid', (e) => {
  try {
    console.log(`[EVENT] OrderPaid     #${e.orderNumber}  receipt=${e.mpesaReceipt ?? 'n/a'}  KES ${e.total}`);
    // Phase 2 TODO: dispatch WhatsApp order confirmation to customer
    // Phase 2 TODO: dispatch fulfilment notification to owner
  } catch {}
});

eventBus.on('OrderCancelled', (e) => {
  try {
    console.log(`[EVENT] OrderCancelled #${e.orderNumber}  reason=${e.reason}`);
  } catch {}
});

eventBus.on('SaleCreated', (e) => {
  try {
    console.log(`[EVENT] SaleCreated   #${e.receiptNumber}  cashier=${e.cashierName}  ${e.paymentMethod}  KES ${e.total}`);
    // Phase 2 TODO: dispatch WhatsApp receipt to customer (if phone provided)
  } catch {}
});

eventBus.on('PaymentFailed', (e) => {
  try {
    console.log(`[EVENT] PaymentFailed  ref=${e.reference}  type=${e.type}  reason=${e.reason}`);
  } catch {}
});

eventBus.on('InventoryAdjusted', (e) => {
  try {
    console.log(`[EVENT] InventoryAdjusted  sku=${e.sku}  ${e.previousStock}→${e.newStock}  actor=${e.actor}`);
  } catch {}
});

eventBus.on('InventoryDeducted', (e) => {
  try {
    console.log(`[EVENT] InventoryDeducted  variantId=${e.variantId}  qty=${e.quantity}  ref=${e.reference}`);
  } catch {}
});
