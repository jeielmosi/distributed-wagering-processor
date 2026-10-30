import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import Decimal from 'decimal.js';
import { LedgerEntryRepository } from '../../../application/ports/ledger-entry.repository';
import { LedgerDirection } from '../../../domain/ledger/ledger-direction';
import { TransactionContext } from '../../../application/ports/transaction-context';
import { WalletLedgerEntry } from '../../../domain/ledger/wallet-ledger-entry';
import { Money } from '../../../domain/money/money';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity';
import { WalletLedgerEntryMapper } from '../mappers/wallet-ledger-entry.mapper';
import { MikroOrmEntityManagerResolver } from '../mikro-orm-entity-manager-resolver';

@Injectable()
export class MikroOrmLedgerEntryRepository implements LedgerEntryRepository {
  constructor(private readonly resolver: MikroOrmEntityManagerResolver) {}

  async save(entry: WalletLedgerEntry, ctx?: TransactionContext): Promise<void> {
    const em = this.em(ctx);
    em.persist(WalletLedgerEntryMapper.toEntity(entry));
    await em.flush();
  }

  async findByWalletIdCursor(
    walletId: string,
    walletVersionCursor: number | undefined,
    limit: number,
    ctx?: TransactionContext
  ): Promise<WalletLedgerEntry[]> {
    const where =
      walletVersionCursor === undefined
        ? { walletId }
        : { walletId, walletVersion: { $lt: walletVersionCursor } };
    const entities = await this.em(ctx).find(WalletLedgerEntryEntity, where, {
      orderBy: { walletVersion: 'desc' },
      limit
    });
    return entities.map((entity) => WalletLedgerEntryMapper.toDomain(entity));
  }

  async findByWalletIdOrdered(
    walletId: string,
    ctx?: TransactionContext
  ): Promise<WalletLedgerEntry[]> {
    const entities = await this.em(ctx).find(
      WalletLedgerEntryEntity,
      { walletId },
      { orderBy: { walletVersion: 'asc' } }
    );
    return entities.map((entity) => WalletLedgerEntryMapper.toDomain(entity));
  }

  async sumByWalletId(walletId: string, ctx?: TransactionContext): Promise<Money | undefined> {
    const rows = await this.em(ctx).execute<{ total: string; currency: string }[]>(
      `select w.currency,
              coalesce(sum(case when l.direction = ? then l.amount else -l.amount end), 0)::text as total
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.currency`,
      [LedgerDirection.Credit, walletId]
    );
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (row === undefined) {
      return undefined;
    }
    const total = new Decimal(row.total);
    const magnitude = Money.from({ amount: total.abs().toFixed(2), currency: row.currency });
    return total.isNegative() ? magnitude.negate() : magnitude;
  }

  private em(ctx?: TransactionContext): EntityManager {
    return this.resolver.resolve(ctx);
  }
}
