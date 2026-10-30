import { InboxMessage } from '../../../domain/messaging/inbox-message';
import { InboxMessageEntity } from '../entities/inbox-message.entity';

export class InboxMessageMapper {
  static toDomain(entity: InboxMessageEntity): InboxMessage {
    return InboxMessage.rehydrate({
      messageId: entity.messageId,
      consumerName: entity.consumerName,
      payloadHash: entity.payloadHash,
      correlationId: entity.correlationId ?? undefined,
      receivedAt: entity.receivedAt,
      processedAt: entity.processedAt ?? undefined
    });
  }

  static toEntity(
    inbox: InboxMessage,
    entity: InboxMessageEntity = new InboxMessageEntity()
  ): InboxMessageEntity {
    entity.messageId = inbox.messageId;
    entity.consumerName = inbox.consumerName;
    entity.payloadHash = inbox.payloadHash;
    entity.correlationId = inbox.correlationId ?? null;
    entity.receivedAt = inbox.receivedAt;
    entity.processedAt = inbox.processedAt ?? null;
    return entity;
  }
}
