import { Inject, Injectable } from '@nestjs/common';
import { FailureCode } from '../../shared/errors/failure-code';
import { InvalidRequestError, ResourceNotFoundError } from '../errors/application.errors';
import { LEDGER_ENTRY_REPOSITORY, UNIT_OF_WORK, WALLET_REPOSITORY } from '../ports/tokens';
import type { LedgerEntryRepository } from '../ports/ledger-entry.repository';
import type { TransactionContext, UnitOfWork } from '../ports/transaction-context';
import { TransactionIsolation } from '../ports/transaction-context';
import type { WalletRepository } from '../ports/wallet.repository';
import { encodeLedgerCursor, decodeLedgerCursor, parseLedgerLimit } from './ledger-cursor';
import type { LedgerPageView } from './query.types';

export interface GetLedgerQuery {
  walletId: string;
  cursor?: string;
  limit?: string;
}

@Injectable()
export class GetLedgerUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(LEDGER_ENTRY_REPOSITORY) private readonly ledger: LedgerEntryRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork
  ) {}

  async execute(query: GetLedgerQuery): Promise<LedgerPageView> {
    const limit = parseLedgerLimit(query.limit);
    const cursor = query.cursor === undefined ? undefined : decodeLedgerCursor(query.cursor);

    return this.unitOfWork.run(async (ctx) => this.page(query.walletId, cursor, limit, ctx), {
      isolation: TransactionIsolation.RepeatableRead,
      readOnly: true
    });
  }

  private async page(
    walletId: string,
    cursor: number | undefined,
    limit: number,
    ctx: TransactionContext
  ): Promise<LedgerPageView> {
    const wallet = await this.wallets.findById(walletId, ctx);
    if (wallet === undefined) {
      throw new ResourceNotFoundError('Wallet not found', FailureCode.WalletNotFound);
    }
    if (cursor !== undefined && cursor > wallet.version) {
      throw new InvalidRequestError('cursor is not coherent with the wallet version');
    }

    const entries = await this.ledger.findByWalletIdCursor(walletId, cursor, limit + 1, ctx);
    const hasMore = entries.length > limit;
    const page = hasMore ? entries.slice(0, limit) : entries;
    const last = page[page.length - 1];

    return {
      items: page.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
        createdAt: entry.createdAt.toISOString()
      })),
      nextCursor: hasMore && last !== undefined ? encodeLedgerCursor(last.walletVersion) : null
    };
  }
}
