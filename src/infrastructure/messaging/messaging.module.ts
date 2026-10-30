import { Module } from '@nestjs/common';
import { ApplicationModule } from '../../application/application.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { loadMessagingSettings } from './messaging.config';
import { MESSAGE_QUEUE, MESSAGING_SETTINGS } from './messaging.tokens';
import { OutboxPublisherWorker } from './outbox-publisher.worker';
import { PendingReferenceWorker } from './pending-reference.worker';
import { SqsMessageQueueAdapter } from './sqs-message-queue.adapter';
import { WagerTransactionConsumer } from './wager-transaction.consumer';

@Module({
  imports: [PersistenceModule, ApplicationModule],
  providers: [
    {
      provide: MESSAGING_SETTINGS,
      useFactory: () => loadMessagingSettings()
    },
    SqsMessageQueueAdapter,
    { provide: MESSAGE_QUEUE, useExisting: SqsMessageQueueAdapter },
    WagerTransactionConsumer,
    OutboxPublisherWorker,
    PendingReferenceWorker
  ],
  exports: [
    WagerTransactionConsumer,
    OutboxPublisherWorker,
    PendingReferenceWorker,
    MESSAGE_QUEUE,
    MESSAGING_SETTINGS
  ]
})
export class MessagingModule {}
