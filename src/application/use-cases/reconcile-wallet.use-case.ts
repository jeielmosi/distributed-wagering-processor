import { Inject, Injectable } from '@nestjs/common';
import { Money } from '../../domain/money/money';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { Wallet } from '../../domain/wallet/wallet';
import { TransactionIsolation } from '../ports/transaction-context';
import { FailureCode } from '../../shared/errors/failure-code';
import { ResourceNotFoundError } from '../errors/application.errors';
import {
  LEDGER_ENTRY_REPOSITORY,
  LOGGER,
  METRICS,
  UNIT_OF_WORK,
  WAGER_TRANSACTION_REPOSITORY,
  WALLET_REPOSITORY
} from '../ports/tokens';
import type { LedgerEntryRepository } from '../ports/ledger-entry.repository';
import type { LoggerPort, MetricsPort } from '../ports/observability.port';
import type { TransactionContext, UnitOfWork } from '../ports/transaction-context';
import type { WagerTransactionRepository } from '../ports/wager-transaction.repository';
import type { WalletRepository } from '../ports/wallet.repository';
import type { ReconciliationView } from './query.types';

const RECONCILIATION_STATEMENT_TIMEOUT_MS = 60000;

@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(LOGGER) private readonly logger: LoggerPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepository,
    @Inject(LEDGER_ENTRY_REPOSITORY) private readonly ledger: LedgerEntryRepository
  ) {}

  async execute(walletId: string): Promise<ReconciliationView> {
    return this.unitOfWork.run(async (ctx) => this.reconcile(walletId, ctx), {
      isolation: TransactionIsolation.RepeatableRead,
      readOnly: true,
      statementTimeoutMs: RECONCILIATION_STATEMENT_TIMEOUT_MS
    });
  }

  private async reconcile(walletId: string, ctx: TransactionContext): Promise<ReconciliationView> {
    const wallet = await this.wallets.findById(walletId, ctx);
    if (wallet === undefined) {
      throw new ResourceNotFoundError('Wallet not found', FailureCode.WalletNotFound);
    }

    const entries = await this.ledger.findByWalletIdOrdered(walletId, ctx);
    const sum = await this.ledger.sumByWalletId(walletId, ctx);
    const opening = await this.transactions.findOpeningByWalletId(walletId, ctx);

    const calculated = sum ?? Money.zero(wallet.currency);
    const chainValid = this.isChainValid(wallet, entries, opening?.id);
    const currenciesValid = entries.every(
      (entry) =>
        entry.money.currency === wallet.currency &&
        entry.balanceBefore.currency === wallet.currency &&
        entry.balanceAfter.currency === wallet.currency
    );
    const difference = calculated.subtract(wallet.balance);
    const consistent = chainValid && currenciesValid && calculated.equals(wallet.balance);

    if (!consistent) {
      this.metrics.reconciliationDivergence();
      this.logger.warn('reconciliation_divergence', {
        walletId: wallet.id,
        playerId: wallet.playerId,
        checkedEntries: entries.length,
        chainValid,
        currenciesValid
      });
    }

    return {
      walletId: wallet.id,
      storedBalance: wallet.balance.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: entries.length
    };
  }

  private isChainValid(
    wallet: Wallet,
    entries: WalletLedgerEntry[],
    openingTransactionId: string | undefined
  ): boolean {
    if (entries.length === 0) {
      return wallet.balance.isZero() && wallet.version === 1;
    }

    const first = entries[0];
    if (first === undefined) {
      return false;
    }

    const hasOpening = openingTransactionId !== undefined;
    const expectedFirstVersion = hasOpening ? 1 : 2;
    if (first.walletVersion !== expectedFirstVersion || !first.balanceBefore.isZero()) {
      return false;
    }
    if (hasOpening && first.transactionId !== openingTransactionId) {
      return false;
    }

    for (const entry of entries) {
      if (!entry.isBalanced()) {
        return false;
      }
    }

    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1];
      const current = entries[index];
      if (previous === undefined || current === undefined) {
        return false;
      }
      if (current.walletVersion !== previous.walletVersion + 1) {
        return false;
      }
      if (!current.balanceBefore.equals(previous.balanceAfter)) {
        return false;
      }
    }

    const last = entries[entries.length - 1];
    if (last === undefined) {
      return false;
    }
    return last.walletVersion === wallet.version && last.balanceAfter.equals(wallet.balance);
  }
}
