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

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = IntegrationEventType.WAGER_TRANSACTION_PENDING_REFERENCE;
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (transaction.status !== WagerTransactionStatus.PendingReference) {
      throw new Error('WagerTransactionPendingReference requires a PENDING_REFERENCE transaction');
    }
    if (transaction.providerId === null || transaction.externalTransactionId === null) {
      throw new Error('WagerTransactionPendingReference requires provider transaction identifiers');
    }
    if (transaction.referenceExternalTransactionId === undefined) {
      throw new Error('WagerTransactionPendingReference requires referenceExternalTransactionId');
    }
    return new WagerTransactionPendingReference({
      eventId: ctx.eventId ?? newUuidV7(),
      aggregateId: transaction.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        playerId: transaction.playerId,
        walletId: transaction.walletId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        referenceExternalTransactionId: transaction.referenceExternalTransactionId
      }
    });
  }
}
