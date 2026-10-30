import { describe, expect, test } from 'bun:test';
import type { EntityManager } from '@mikro-orm/postgresql';
import { metrics } from '../../observability/metrics';
import { MikroOrmEntityManagerResolver } from '../mikro-orm-entity-manager-resolver';
import { MikroOrmWalletRepository } from './mikro-orm-wallet.repository';

function repositoryThrowing(code: string): MikroOrmWalletRepository {
  const error = Object.assign(new Error('database error'), { code });
  const em = {
    findOne: async () => {
      throw error;
    }
  } as unknown as EntityManager;
  const resolver = { resolve: () => em } as unknown as MikroOrmEntityManagerResolver;
  return new MikroOrmWalletRepository(resolver);
}

async function counterValue(metric: {
  get(): Promise<{ values: { value: number }[] }>;
}): Promise<number> {
  const snapshot = await metric.get();
  return snapshot.values[0]?.value ?? 0;
}

async function histogramCount(name: string): Promise<number> {
  const output = await metrics.render();
  const match = output.match(new RegExp(`^${name}_count(?:\\{[^}]*\\})? (\\d+)$`, 'm'));
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

describe('MikroOrmWalletRepository lock metrics', () => {
  test('contabiliza lock timeout (55P03) e tempo de espera', async () => {
    const timeoutsBefore = await counterValue(metrics.dbLockTimeoutsTotal);
    const waitSamplesBefore = await histogramCount('db_lock_wait_seconds');

    await expect(repositoryThrowing('55P03').findByIdWithLock('wallet-1')).rejects.toThrow();

    expect(await counterValue(metrics.dbLockTimeoutsTotal)).toBe(timeoutsBefore + 1);
    expect(await histogramCount('db_lock_wait_seconds')).toBe(waitSamplesBefore + 1);
  });

  test('contabiliza deadlock (40P01)', async () => {
    const before = await counterValue(metrics.dbDeadlocksTotal);

    await expect(repositoryThrowing('40P01').findByIdWithLock('wallet-2')).rejects.toThrow();

    expect(await counterValue(metrics.dbDeadlocksTotal)).toBe(before + 1);
  });
});
