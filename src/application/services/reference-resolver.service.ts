import { Inject, Injectable } from '@nestjs/common';
import {
  evaluateReference,
  ReferenceOutcome
} from '../../domain/wager-transaction/reference-policy';
import type {
  ReferenceDecision,
  ReferenceSnapshot
} from '../../domain/wager-transaction/reference-policy';
import { WagerTransactionKind } from '../../domain/wager-transaction/wager-transaction-kind';
import type { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import type { TransactionContext } from '../ports/transaction-context';
import { WAGER_TRANSACTION_REPOSITORY } from '../ports/tokens';
import type { WagerTransactionRepository } from '../ports/wager-transaction.repository';

export interface ReferenceResolution {
  decision: ReferenceDecision;
  target?: WagerTransaction;
}

@Injectable()
export class ReferenceResolverService {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepository
  ) {}

  async resolve(request: WagerTransaction, ctx?: TransactionContext): Promise<ReferenceResolution> {
    const externalReference = request.referenceExternalTransactionId;
    if (externalReference === undefined || request.providerId === null) {
      return { decision: { outcome: ReferenceOutcome.Apply } };
    }

    const target = await this.transactions.findByProviderAndExternalId(
      request.providerId,
      externalReference,
      ctx
    );
    const snapshot = target === undefined ? null : await this.snapshotFor(target, ctx);

    return { decision: evaluateReference(request, snapshot), target };
  }

  private async snapshotFor(
    target: WagerTransaction,
    ctx?: TransactionContext
  ): Promise<ReferenceSnapshot> {
    const reversal = await this.transactions.findByReferenceTransactionId(target.id, ctx);

    if (target.providerId === null || target.externalTransactionId === null) {
      return {
        target,
        reversedBy: reversal?.kind
      };
    }

    const settlement = await this.transactions.findSettlementByProviderAndReference(
      target.providerId,
      target.externalTransactionId,
      ctx
    );
    let hasProcessedWin = false;
    if (settlement !== undefined && settlement.kind === WagerTransactionKind.Win) {
      const settlementReversal = await this.transactions.findByReferenceTransactionId(
        settlement.id,
        ctx
      );
      hasProcessedWin = settlementReversal === undefined;
    }

    return {
      target,
      reversedBy: reversal?.kind,
      settlementKind: settlement?.kind,
      hasProcessedWin
    };
  }
}
