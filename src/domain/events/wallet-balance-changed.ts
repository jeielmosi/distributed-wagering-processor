import { newUuidV7 } from '../../shared/id/uuid';
import { LedgerDirection } from '../ledger/ledger-direction';
import { WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { MoneyProps } from '../money/money';
import {
  EventContext,
  IntegrationEvent,
  IntegrationEventProps,
  IntegrationEventType
} from './integration-event';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = IntegrationEventType.WALLET_BALANCE_CHANGED;
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: ctx.eventId ?? newUuidV7(),
      aggregateId: entry.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion
      }
    });
  }
}
