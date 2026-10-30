import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, Options } from '@mikro-orm/postgresql';
import { InboxMessageEntity } from './entities/inbox-message.entity';
import { OutboxMessageEntity } from './entities/outbox-message.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import { WalletEntity } from './entities/wallet.entity';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity';

export const DEFAULT_DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/wagering';

export const SOURCE_MIGRATIONS_PATH = 'src/infrastructure/persistence/migrations';
export const MIGRATIONS_PATH = process.env.MIGRATIONS_PATH ?? SOURCE_MIGRATIONS_PATH;

export interface MikroOrmConfigOverrides {
  clientUrl?: string;
  migrationsPath?: string;
  debug?: boolean;
}

export function createMikroOrmConfig(overrides: MikroOrmConfigOverrides = {}): Options {
  return defineConfig({
    clientUrl: overrides.clientUrl ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    entities: [
      WalletEntity,
      WagerTransactionEntity,
      WalletLedgerEntryEntity,
      InboxMessageEntity,
      OutboxMessageEntity
    ],
    extensions: [Migrator],
    migrations: {
      path: overrides.migrationsPath ?? MIGRATIONS_PATH,
      transactional: true,
      allOrNothing: true,
      snapshot: false
    },
    pool: {
      min: 0,
      max: 10,
      acquireTimeoutMillis: 5000,
      idleTimeoutMillis: 30000
    },
    driverOptions: {
      connection: {
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000
      }
    },
    debug: overrides.debug ?? false
  });
}

const config = createMikroOrmConfig();

export default config;
