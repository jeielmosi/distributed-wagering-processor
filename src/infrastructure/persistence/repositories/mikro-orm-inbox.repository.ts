import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { InboxInsertResult, InboxRepository } from '../../../application/ports/inbox.repository';
import { TransactionContext } from '../../../application/ports/transaction-context';
import { InboxMessage } from '../../../domain/messaging/inbox-message';
import { InboxMessageEntity } from '../entities/inbox-message.entity';
import { InboxMessageMapper } from '../mappers/inbox-message.mapper';
import { MikroOrmEntityManagerResolver } from '../mikro-orm-entity-manager-resolver';

@Injectable()
export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly resolver: MikroOrmEntityManagerResolver) {}

  async findByConsumerAndMessageId(
    consumerName: string,
    messageId: string,
    ctx?: TransactionContext
  ): Promise<InboxMessage | undefined> {
    const entity = await this.em(ctx).findOne(InboxMessageEntity, { consumerName, messageId });
    return entity === null ? undefined : InboxMessageMapper.toDomain(entity);
  }

  async insertIfAbsent(inbox: InboxMessage, ctx?: TransactionContext): Promise<InboxInsertResult> {
    const rows = await this.em(ctx).execute<{ inserted: boolean }[]>(
      `insert into inbox_messages
         (message_id, consumer_name, payload_hash, correlation_id, received_at, processed_at)
       values (?, ?, ?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning true as inserted`,
      [
        inbox.messageId,
        inbox.consumerName,
        inbox.payloadHash,
        inbox.correlationId ?? null,
        inbox.receivedAt,
        inbox.processedAt ?? null
      ]
    );
    if (Array.isArray(rows) && rows.length > 0) {
      return { inserted: true };
    }
    return {
      inserted: false,
      existing: await this.findByConsumerAndMessageId(inbox.consumerName, inbox.messageId, ctx)
    };
  }

  private em(ctx?: TransactionContext): EntityManager {
    return this.resolver.resolve(ctx);
  }
}
