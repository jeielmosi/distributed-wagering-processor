import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ApplicationModule } from './application/application.module';
import { MessagingModule } from './infrastructure/messaging/messaging.module';
import { ObservabilityModule } from './infrastructure/observability/observability.module';
import { ObservabilityPortsModule } from './infrastructure/observability/observability-ports.module';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { NoopAuthGuard } from './infrastructure/auth/noop-auth.guard';
import { HealthController } from './presentation/http/controllers/health.controller';
import { WageringController } from './presentation/http/controllers/wagering.controller';
import { WalletController } from './presentation/http/controllers/wallet.controller';

@Module({
  imports: [
    PersistenceModule,
    ObservabilityPortsModule,
    ApplicationModule,
    MessagingModule,
    ObservabilityModule
  ],
  controllers: [WalletController, WageringController, HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: NoopAuthGuard
    }
  ]
})
export class AppModule {}
