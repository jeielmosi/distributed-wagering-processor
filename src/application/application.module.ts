import { Module } from '@nestjs/common';
import { IdempotencyService } from './services/idempotency.service';
import { ReferenceResolverService } from './services/reference-resolver.service';
import { TransactionApplicationService } from './services/transaction-application.service';
import { CreateWalletUseCase } from './use-cases/create-wallet.use-case';
import { GetLedgerUseCase } from './use-cases/get-ledger.use-case';
import { GetTransactionUseCase } from './use-cases/get-transaction.use-case';
import { GetWalletUseCase } from './use-cases/get-wallet.use-case';
import { ProcessWagerTransactionUseCase } from './use-cases/process-wager-transaction.use-case';
import { ReconcileWalletUseCase } from './use-cases/reconcile-wallet.use-case';
import { ResolvePendingReferenceUseCase } from './use-cases/resolve-pending-reference.use-case';

const providers = [
  IdempotencyService,
  ReferenceResolverService,
  TransactionApplicationService,
  CreateWalletUseCase,
  ProcessWagerTransactionUseCase,
  ResolvePendingReferenceUseCase,
  ReconcileWalletUseCase,
  GetWalletUseCase,
  GetLedgerUseCase,
  GetTransactionUseCase
];

@Module({
  providers,
  exports: providers
})
export class ApplicationModule {}
