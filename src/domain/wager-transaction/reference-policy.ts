import { FailureCode } from '../../shared/errors/failure-code';
import { WagerTransactionKind } from './wager-transaction-kind';
import { WagerTransactionStatus } from './wager-transaction-status';
import { WagerTransaction } from './wager-transaction';

export interface ReferenceSnapshot {
  target: WagerTransaction;
  reversedBy?: WagerTransactionKind;
  settlementKind?: WagerTransactionKind;
  hasProcessedWin?: boolean;
}

export enum ReferenceOutcome {
  Apply = 'APPLY',
  Pending = 'PENDING',
  Reject = 'REJECT'
}

export type ReferenceDecision =
  | { outcome: ReferenceOutcome.Apply }
  | { outcome: ReferenceOutcome.Pending }
  | { outcome: ReferenceOutcome.Reject; failureCode: FailureCode };

function isReferenceKindAllowed(
  requestKind: WagerTransactionKind,
  targetKind: WagerTransactionKind
): boolean {
  switch (requestKind) {
    case WagerTransactionKind.Win:
    case WagerTransactionKind.Loss:
    case WagerTransactionKind.Refund:
      return targetKind === WagerTransactionKind.Bet;
    case WagerTransactionKind.Rollback:
      return (
        targetKind === WagerTransactionKind.Bet ||
        targetKind === WagerTransactionKind.Win ||
        targetKind === WagerTransactionKind.Refund
      );
    default:
      return false;
  }
}

function isContextMismatch(request: WagerTransaction, target: WagerTransaction): boolean {
  return (
    request.providerId !== target.providerId ||
    request.playerId !== target.playerId ||
    request.walletId !== target.walletId ||
    request.roundId !== target.roundId ||
    request.money.currency !== target.money.currency
  );
}

export function evaluateReference(
  request: WagerTransaction,
  snapshot: ReferenceSnapshot | null
): ReferenceDecision {
  if (request.referenceExternalTransactionId === undefined) {
    return { outcome: ReferenceOutcome.Apply };
  }
  if (snapshot === null) {
    return { outcome: ReferenceOutcome.Pending };
  }

  const target = snapshot.target;
  if (
    target.status === WagerTransactionStatus.Pending ||
    target.status === WagerTransactionStatus.PendingReference
  ) {
    return { outcome: ReferenceOutcome.Pending };
  }
  if (
    target.status === WagerTransactionStatus.Rejected ||
    target.status === WagerTransactionStatus.Failed
  ) {
    return { outcome: ReferenceOutcome.Reject, failureCode: FailureCode.ReferenceNotProcessed };
  }
  if (target.status !== WagerTransactionStatus.Processed) {
    return { outcome: ReferenceOutcome.Pending };
  }

  if (isContextMismatch(request, target)) {
    return { outcome: ReferenceOutcome.Reject, failureCode: FailureCode.ReferenceContextMismatch };
  }
  if (!isReferenceKindAllowed(request.kind, target.kind)) {
    return { outcome: ReferenceOutcome.Reject, failureCode: FailureCode.InvalidReferenceKind };
  }
  if (
    (request.kind === WagerTransactionKind.Refund ||
      request.kind === WagerTransactionKind.Rollback) &&
    !request.money.equals(target.money)
  ) {
    return { outcome: ReferenceOutcome.Reject, failureCode: FailureCode.ReferenceAmountMismatch };
  }
  if (
    (request.kind === WagerTransactionKind.Win || request.kind === WagerTransactionKind.Loss) &&
    snapshot.settlementKind !== undefined
  ) {
    return { outcome: ReferenceOutcome.Reject, failureCode: FailureCode.ReferenceAlreadySettled };
  }
  if (snapshot.reversedBy !== undefined) {
    return { outcome: ReferenceOutcome.Reject, failureCode: FailureCode.ReferenceAlreadyReverted };
  }
  if (
    (request.kind === WagerTransactionKind.Refund ||
      request.kind === WagerTransactionKind.Rollback) &&
    target.kind === WagerTransactionKind.Bet &&
    snapshot.hasProcessedWin === true
  ) {
    return { outcome: ReferenceOutcome.Reject, failureCode: FailureCode.ReferenceHasProcessedWin };
  }

  return { outcome: ReferenceOutcome.Apply };
}
