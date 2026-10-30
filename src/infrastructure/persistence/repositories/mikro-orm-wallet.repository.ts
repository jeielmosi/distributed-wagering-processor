import { Injectable } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { WalletRepository } from '../../../application/ports/wallet.repository';
import { TransactionContext } from '../../../application/ports/transaction-context';
import { Wallet } from '../../../domain/wallet/wallet';
import { metrics } from '../../observability/metrics';
import { postgresErrorCode, PostgresSqlState } from '../postgres/postgres-error';
import { WalletEntity } from '../entities/wallet.entity';
import { WalletMapper } from '../mappers/wallet.mapper';
import { MikroOrmEntityManagerResolver } from '../mikro-orm-entity-manager-resolver';

class WalletVersionConflictError extends Error {
  readonly code = PostgresSqlState.SerializationFailure;

  constructor(walletId: string, expectedVersion: number) {
    super(`Wallet ${walletId} was modified concurrently (expected version ${expectedVersion})`);
    this.name = 'WalletVersionConflictError';
  }
}

@Injectable()
export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly resolver: MikroOrmEntityManagerResolver) {}

  async findById(id: string, ctx?: TransactionContext): Promise<Wallet | undefined> {
    const entity = await this.em(ctx).findOne(WalletEntity, { id });
    return entity === null ? undefined : WalletMapper.toDomain(entity);
  }

  async findByIdWithLock(id: string, ctx?: TransactionContext): Promise<Wallet | undefined> {
    const startedAt = performance.now();
    try {
      const entity = await this.em(ctx).findOne(
        WalletEntity,
        { id },
        { lockMode: LockMode.PESSIMISTIC_WRITE }
      );
      return entity === null ? undefined : WalletMapper.toDomain(entity);
    } catch (error) {
      const code = postgresErrorCode(error);
      if (code === '55P03') {
        metrics.lockTimeout();
      } else if (code === '40P01') {
        metrics.deadlock();
      }
      throw error;
    } finally {
      metrics.observeLockWait((performance.now() - startedAt) / 1000);
    }
  }

  async save(wallet: Wallet, ctx?: TransactionContext): Promise<void> {
    const em = this.em(ctx);
    const rows = await em.execute<{ version: number }[]>(
      'select version from wallets where id = ?',
      [wallet.id]
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      em.persist(WalletMapper.toEntity(wallet));
      await em.flush();
      wallet.markPersisted();
      return;
    }

    const currentVersion = Number(rows[0]?.version);
    if (wallet.version === wallet.loadedVersion) {
      return;
    }
    if (currentVersion !== wallet.loadedVersion) {
      throw new WalletVersionConflictError(wallet.id, currentVersion);
    }

    const updated = await em.execute<{ version: number }[]>(
      `update wallets
          set balance_amount = ?, version = ?, updated_at = ?
        where id = ? and version = ?
        returning version`,
      [wallet.balance.toString(), wallet.version, wallet.updatedAt, wallet.id, currentVersion]
    );
    if (!Array.isArray(updated) || updated.length === 0) {
      throw new WalletVersionConflictError(wallet.id, currentVersion);
    }

    // O UPDATE acima é SQL bruto; mantém o Identity Map coerente para leituras
    // posteriores dentro da mesma transação.
    const managed = await em.findOne(WalletEntity, { id: wallet.id });
    if (managed !== null) {
      managed.balanceAmount = wallet.balance.toString();
      managed.version = wallet.version;
      managed.updatedAt = wallet.updatedAt;
    }
    wallet.markPersisted();
  }

  private em(ctx?: TransactionContext): EntityManager {
    return this.resolver.resolve(ctx);
  }
}
