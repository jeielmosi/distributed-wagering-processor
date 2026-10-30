import { OutboxMessage } from '../../../domain/messaging/outbox-message';
import { OutboxMessageEntity } from '../entities/outbox-message.entity';

function correlationIdFromPayload(payload: Readonly<Record<string, unknown>>): string | undefined {
  const value = payload.correlationId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export class OutboxMessageMapper {
  static toDomain(entity: OutboxMessageEntity): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: entity.id,
      aggregateId: entity.aggregateId,
      eventType: entity.eventType,
      payload: entity.payload,
      occurredAt: entity.occurredAt,
      attempts: entity.attempts,
      claimCount: entity.claimCount,
      nextAttemptAt: entity.nextAttemptAt,
      publishedAt: entity.publishedAt ?? undefined,
      deadLetteredAt: entity.deadLetteredAt ?? undefined,
      lastError: entity.lastError ?? undefined,
      createdAt: entity.occurredAt
    });
  }

  static toEntity(
    outbox: OutboxMessage,
    entity: OutboxMessageEntity = new OutboxMessageEntity()
  ): OutboxMessageEntity {
    entity.id = outbox.id;
    entity.aggregateId = outbox.aggregateId;
    entity.eventType = outbox.eventType;
    entity.payload = { ...outbox.payload };
    entity.correlationId = entity.correlationId ?? correlationIdFromPayload(outbox.payload) ?? null;
    entity.occurredAt = outbox.occurredAt;
    entity.attempts = outbox.attempts;
    entity.claimCount = outbox.claimCount;
    entity.nextAttemptAt = outbox.nextAttemptAt;
    entity.publishedAt = outbox.publishedAt ?? null;
    entity.deadLetteredAt = outbox.deadLetteredAt ?? null;
    entity.lastError = outbox.lastError ?? null;
    return entity;
  }
}
