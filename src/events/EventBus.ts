import { EventEmitter } from 'events';

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
  items: any[];
}

export interface SaleCreatedEvent {
  receiptNumber: string;
  cashierName: string;
  customerName: string;
  customerPhone?: string | null;
  mpesaReceipt?: string | null;
  total: number;
  paymentMethod: string;
  items: any[];
}

class DomainEventBus extends EventEmitter {}

export const eventBus = new DomainEventBus();

// Domain Event Listeners (Decoupled Responsibilities)
eventBus.on('OrderPaid', (event: OrderPaidEvent) => {
  console.log(`⚡ [EVENT BUS] OrderPaid Triggered for #${event.orderNumber}`);
});

eventBus.on('SaleCreated', (event: SaleCreatedEvent) => {
  console.log(`⚡ [EVENT BUS] SaleCreated Triggered for Receipt #${event.receiptNumber}`);
});
