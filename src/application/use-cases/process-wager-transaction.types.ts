import type { FailureCode } from '../../shared/errors/failure-code';
import type { MoneyProps } from '../../domain/money/money';
import type { WagerTransactionKind } from '../../domain/wager-transaction/wager-transaction-kind';
import type { WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction-status';

export interface ProcessWagerTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
  causationId?: string;
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}
