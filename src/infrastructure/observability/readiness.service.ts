import { Inject, Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { MESSAGE_QUEUE, MESSAGING_SETTINGS } from '../messaging/messaging.tokens';
import type { MessagingSettings } from '../messaging/messaging.config';
import type { MessageQueuePort } from '../../application/ports/message-queue.port';
import { DependencyStatus, HealthStatus } from '../../application/ports/readiness.port';
import type { ReadinessPort, ReadinessResult } from '../../application/ports/readiness.port';
import { MIKRO_ORM } from '../persistence/mikro-orm.module';
import { logger } from './structured-logger';

@Injectable()
export class ReadinessService implements ReadinessPort {
  private readonly log = logger.child({ component: 'readiness' });

  constructor(
    @Inject(MIKRO_ORM) private readonly orm: MikroORM,
    @Inject(MESSAGE_QUEUE) private readonly queue: MessageQueuePort,
    @Inject(MESSAGING_SETTINGS) private readonly settings: MessagingSettings
  ) {}

  async check(): Promise<ReadinessResult> {
    const [postgres, sqs] = await Promise.all([this.checkPostgres(), this.checkSqs()]);
    const result: ReadinessResult = {
      status:
        postgres === DependencyStatus.Up && sqs === DependencyStatus.Up
          ? HealthStatus.Ok
          : HealthStatus.Error,
      checks: { postgres, sqs }
    };
    if (result.status === HealthStatus.Error) {
      this.log.warn('readiness_failed', { postgres, sqs });
    }
    return result;
  }

  private async checkPostgres(): Promise<DependencyStatus> {
    try {
      await this.orm.em.fork().execute('select 1');
      return DependencyStatus.Up;
    } catch (error) {
      this.log.warn('readiness_postgres_failed', { error });
      return DependencyStatus.Down;
    }
  }

  private async checkSqs(): Promise<DependencyStatus> {
    const queueUrls = [
      this.settings.wagerQueueUrl,
      this.settings.wagerDlqUrl,
      this.settings.eventsQueueUrl,
      this.settings.eventsDlqUrl
    ];
    try {
      await Promise.all(queueUrls.map(async (url) => await this.queue.getQueueAttributes(url)));
      return DependencyStatus.Up;
    } catch (error) {
      this.log.warn('readiness_sqs_failed', { error });
      return DependencyStatus.Down;
    }
  }
}
