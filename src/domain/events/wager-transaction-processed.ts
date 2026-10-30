import { newUuidV7 } from '../../shared/id/uuid';
import { MoneyProps } from '../money/money';
import { WagerTransactionKind } from '../wager-transaction/wager-transaction-kind';
import { WagerTransactionStatus } from '../wager-transaction/wager-transaction-status';
import { WagerTransaction } from '../wager-transaction/wager-transaction';
import {
  EventContext,
  IntegrationEvent,
  IntegrationEventProps,
  IntegrationEventType
} from './integration-event';

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string | null;
  externalTransactionId: string | null;
  playerId: string;
  walletId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerTransactionKind;
  money: MoneyProps;
  balanceAfter: MoneyProps;
  referenceTransactionId?: string;
  affectsBalance: boolean;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = IntegrationEventType.WAGER_TRANSACTION_PROCESSED;
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (
      transaction.status !== WagerTransactionStatus.Processed ||
      transaction.balanceAfter === undefined
    ) {
      throw new Error(
        'WagerTransactionProcessed requires a PROCESSED transaction with balanceAfter'
      );
    }
    const data: WagerTransactionProcessedData = {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      playerId: transaction.playerId,
      walletId: transaction.walletId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: transaction.money.toJSON(),
      balanceAfter: transaction.balanceAfter.toJSON(),
      affectsBalance: transaction.affectsBalance()
    };
    if (transaction.referenceTransactionId !== undefined) {
      data.referenceTransactionId = transaction.referenceTransactionId;
    }
    return new WagerTransactionProcessed({
      eventId: ctx.eventId ?? newUuidV7(),
      aggregateId: transaction.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data
    });
  }
}
