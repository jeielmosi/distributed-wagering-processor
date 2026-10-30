import { Module } from '@nestjs/common';
import { READINESS } from '../../application/ports/tokens';
import { MessagingModule } from '../messaging/messaging.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { DlqMetricsCollector } from './dlq-metrics.collector';
import { MetricsController } from './metrics.controller';
import { ReadinessService } from './readiness.service';

@Module({
  imports: [PersistenceModule, MessagingModule],
  controllers: [MetricsController],
  providers: [
    ReadinessService,
    DlqMetricsCollector,
    { provide: READINESS, useExisting: ReadinessService }
  ],
  exports: [ReadinessService, READINESS]
})
export class ObservabilityModule {}
