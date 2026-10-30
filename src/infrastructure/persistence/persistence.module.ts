import { Global, Module } from '@nestjs/common';
import {
  CLOCK,
  INBOX_REPOSITORY,
  LEDGER_ENTRY_REPOSITORY,
  OUTBOX_REPOSITORY,
  PERSISTENCE_ERROR_TRANSLATOR,
  UNIT_OF_WORK,
  WAGER_TRANSACTION_REPOSITORY,
  WALLET_REPOSITORY
} from '../../application/ports/tokens';
import { MikroOrmModule } from './mikro-orm.module';
import { MikroOrmClock } from './mikro-orm-clock';
import { MikroOrmEntityManagerResolver } from './mikro-orm-entity-manager-resolver';
import { MikroOrmUnitOfWork } from './mikro-orm-unit-of-work';
import { PostgresErrorTranslator } from './postgres/postgres-error-translator';
import { MikroOrmInboxRepository } from './repositories/mikro-orm-inbox.repository';
import { MikroOrmLedgerEntryRepository } from './repositories/mikro-orm-ledger-entry.repository';
import { MikroOrmOutboxRepository } from './repositories/mikro-orm-outbox.repository';
import { MikroOrmWagerTransactionRepository } from './repositories/mikro-orm-wager-transaction.repository';
import { MikroOrmWalletRepository } from './repositories/mikro-orm-wallet.repository';

@Global()
@Module({
  imports: [MikroOrmModule],
  providers: [
    MikroOrmEntityManagerResolver,
    MikroOrmUnitOfWork,
    MikroOrmClock,
    PostgresErrorTranslator,
    MikroOrmWalletRepository,
    MikroOrmWagerTransactionRepository,
    MikroOrmLedgerEntryRepository,
    MikroOrmInboxRepository,
    MikroOrmOutboxRepository,
    { provide: UNIT_OF_WORK, useExisting: MikroOrmUnitOfWork },
    { provide: CLOCK, useExisting: MikroOrmClock },
    { provide: WALLET_REPOSITORY, useExisting: MikroOrmWalletRepository },
    { provide: WAGER_TRANSACTION_REPOSITORY, useExisting: MikroOrmWagerTransactionRepository },
    { provide: LEDGER_ENTRY_REPOSITORY, useExisting: MikroOrmLedgerEntryRepository },
    { provide: INBOX_REPOSITORY, useExisting: MikroOrmInboxRepository },
    { provide: OUTBOX_REPOSITORY, useExisting: MikroOrmOutboxRepository },
    { provide: PERSISTENCE_ERROR_TRANSLATOR, useExisting: PostgresErrorTranslator }
  ],
  exports: [
    MikroOrmModule,
    UNIT_OF_WORK,
    CLOCK,
    WALLET_REPOSITORY,
    WAGER_TRANSACTION_REPOSITORY,
    LEDGER_ENTRY_REPOSITORY,
    INBOX_REPOSITORY,
    OUTBOX_REPOSITORY,
    PERSISTENCE_ERROR_TRANSLATOR
  ]
})
export class PersistenceModule {}
