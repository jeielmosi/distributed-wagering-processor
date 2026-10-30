import { Inject, Injectable } from '@nestjs/common';
import { LedgerDirection } from '../../domain/ledger/ledger-direction';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { Money } from '../../domain/money/money';
import type { MoneyProps } from '../../domain/money/money';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { mapTransactionEvents } from '../../domain/events/event-mapper';
import { WagerTransaction } from '../../domain/wager-transaction/wager-transaction';
import { WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction-status';
import { Wallet } from '../../domain/wallet/wallet';
import { newUuidV7 } from '../../shared/id/uuid';
import { PersistenceConflict, UniqueConstraintConflictError } from '../errors/persistence.errors';
import { WalletAlreadyExistsError } from '../errors/application.errors';
import {
  CLOCK,
  LEDGER_ENTRY_REPOSITORY,
  LOGGER,
  METRICS,
  OUTBOX_REPOSITORY,
  UNIT_OF_WORK,
  WAGER_TRANSACTION_REPOSITORY,
  WALLET_REPOSITORY
} from '../ports/tokens';
import type { Clock } from '../ports/clock.port';
import type { LoggerPort, MetricsPort } from '../ports/observability.port';
import type { OutboxRepository } from '../ports/outbox.repository';
import type { UnitOfWork } from '../ports/transaction-context';
import type { LedgerEntryRepository } from '../ports/ledger-entry.repository';
import type { WagerTransactionRepository } from '../ports/wager-transaction.repository';
import type { WalletRepository } from '../ports/wallet.repository';
import type { WalletView } from './query.types';

enum WalletCreationStatus {
  Created = 'CREATED'
}

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
  causationId?: string;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly logger: LoggerPort,
    @Inject(METRICS) private readonly metrics: MetricsPort,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepository,
    @Inject(LEDGER_ENTRY_REPOSITORY) private readonly ledger: LedgerEntryRepository,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository
  ) {}

  async execute(command: CreateWalletCommand): Promise<WalletView> {
    const walletId = newUuidV7();
    const initialBalance = Money.from(command.initialBalance);

    try {
      const view = await this.unitOfWork.run(async (ctx) => {
        const now = await this.clock.now(ctx);
        const wallet = Wallet.open({
          id: walletId,
          playerId: command.playerId,
          initialBalance,
          at: now
        });
        await this.wallets.save(wallet, ctx);

        if (initialBalance.isPositive()) {
          const opening = WagerTransaction.opening({
            id: newUuidV7(),
            walletId,
            playerId: command.playerId,
            money: initialBalance,
            balanceAfter: initialBalance,
            at: now,
            correlationId: command.correlationId,
            causationId: command.causationId
          });
          await this.transactions.save(opening, ctx);

          const entry = WalletLedgerEntry.create({
            id: newUuidV7(),
            walletId,
            transactionId: opening.id,
            direction: LedgerDirection.Credit,
            money: initialBalance,
            balanceBefore: Money.zero(initialBalance.currency),
            balanceAfter: initialBalance,
            walletVersion: 1,
            createdAt: now
          });
          await this.ledger.save(entry, ctx);

          const events = mapTransactionEvents(opening, entry, {
            correlationId: command.correlationId,
            causationId: command.causationId,
            occurredAt: now
          });
          for (const event of events) {
            await this.outbox.save(OutboxMessage.enqueue(event), ctx);
          }
        }

        return this.toView(wallet);
      });
      if (initialBalance.isPositive()) {
        this.metrics.transactionPersisted(WagerTransactionStatus.Processed);
      }
      this.logger.info('wallet_created', {
        correlationId: command.correlationId,
        walletId: view.id,
        playerId: view.playerId,
        status: WalletCreationStatus.Created
      });
      return view;
    } catch (error) {
      if (
        error instanceof UniqueConstraintConflictError &&
        error.conflict === PersistenceConflict.WalletPlayerCurrency
      ) {
        throw new WalletAlreadyExistsError();
      }
      throw error;
    }
  }

  private toView(wallet: Wallet): WalletView {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version
    };
  }
}
