import { newUuidV7 } from '../../shared/id/uuid';
import { FailureCode } from '../../shared/errors/failure-code';
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

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
  referenceExternalTransactionId?: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = IntegrationEventType.WAGER_TRANSACTION_REJECTED;
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (
      transaction.status !== WagerTransactionStatus.Rejected ||
      transaction.failureCode === undefined
    ) {
      throw new Error('WagerTransactionRejected requires a REJECTED transaction with failureCode');
    }
    if (transaction.providerId === null || transaction.externalTransactionId === null) {
      throw new Error('WagerTransactionRejected requires provider transaction identifiers');
    }
    const data: WagerTransactionRejectedData = {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      playerId: transaction.playerId,
      walletId: transaction.walletId,
      kind: transaction.kind,
      money: transaction.money.toJSON(),
      failureCode: transaction.failureCode
    };
    if (transaction.referenceExternalTransactionId !== undefined) {
      data.referenceExternalTransactionId = transaction.referenceExternalTransactionId;
    }
    return new WagerTransactionRejected({
      eventId: ctx.eventId ?? newUuidV7(),
      aggregateId: transaction.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data
    });
  }
}
