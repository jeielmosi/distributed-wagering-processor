import { Injectable } from '@nestjs/common';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';

const DAY_MS = 86_400_000;

export interface RetentionPurgeOptions {
  inboxDays: number;
  outboxDays: number;
  batchSize: number;
  dryRun: boolean;
}

export interface RetentionPurgeResult {
  dryRun: boolean;
  inboxCutoff: string;
  outboxCutoff: string;
  inboxArchived: number;
  outboxArchived: number;
}

const ARCHIVE_INBOX_BATCH = `
  with due as (
    select message_id, consumer_name
      from inbox_messages
     where processed_at is not null
       and processed_at < ?
     order by processed_at asc
     limit ?
     for update skip locked
  ),
  archived as (
    insert into inbox_messages_archive
      (message_id, consumer_name, payload_hash, correlation_id, received_at, processed_at, archived_at)
    select i.message_id, i.consumer_name, i.payload_hash, i.correlation_id, i.received_at, i.processed_at, now()
      from inbox_messages i
      join due on due.consumer_name = i.consumer_name and due.message_id = i.message_id
    returning consumer_name, message_id
  )
  delete from inbox_messages i
   using archived a
   where i.consumer_name = a.consumer_name
     and i.message_id = a.message_id
  returning 1 as archived
`;

const ARCHIVE_OUTBOX_BATCH = `
  with due as (
    select id
      from outbox_messages
     where (published_at is not null or dead_lettered_at is not null)
       and coalesce(published_at, dead_lettered_at) < ?
     order by coalesce(published_at, dead_lettered_at) asc
     limit ?
     for update skip locked
  ),
  archived as (
    insert into outbox_messages_archive
      (id, aggregate_id, event_type, payload, correlation_id, occurred_at,
       attempts, claim_count, next_attempt_at, published_at, dead_lettered_at, last_error, archived_at)
    select o.id, o.aggregate_id, o.event_type, o.payload, o.correlation_id, o.occurred_at,
           o.attempts, o.claim_count, o.next_attempt_at, o.published_at, o.dead_lettered_at, o.last_error, now()
      from outbox_messages o
      join due on due.id = o.id
    returning id
  )
  delete from outbox_messages o
   using archived a
   where o.id = a.id
  returning 1 as archived
`;

@Injectable()
export class RetentionPurgeService {
  constructor(private readonly orm: MikroORM) {}

  async run(options: RetentionPurgeOptions): Promise<RetentionPurgeResult> {
    const inboxCutoff = new Date(Date.now() - options.inboxDays * DAY_MS);
    const outboxCutoff = new Date(Date.now() - options.outboxDays * DAY_MS);
    const em = this.orm.em.fork();

    if (options.dryRun) {
      return {
        dryRun: true,
        inboxCutoff: inboxCutoff.toISOString(),
        outboxCutoff: outboxCutoff.toISOString(),
        inboxArchived: await this.countInbox(em, inboxCutoff),
        outboxArchived: await this.countOutbox(em, outboxCutoff)
      };
    }

    return {
      dryRun: false,
      inboxCutoff: inboxCutoff.toISOString(),
      outboxCutoff: outboxCutoff.toISOString(),
      inboxArchived: await this.archiveInbox(em, inboxCutoff, options.batchSize),
      outboxArchived: await this.archiveOutbox(em, outboxCutoff, options.batchSize)
    };
  }

  private async countInbox(em: EntityManager, cutoff: Date): Promise<number> {
    const rows = await em.execute<{ count: number }[]>(
      'select count(*)::int as count from inbox_messages where processed_at is not null and processed_at < ?',
      [cutoff]
    );
    return Number(rows[0]?.count ?? 0);
  }

  private async countOutbox(em: EntityManager, cutoff: Date): Promise<number> {
    const rows = await em.execute<{ count: number }[]>(
      `select count(*)::int as count from outbox_messages
        where (published_at is not null or dead_lettered_at is not null)
          and coalesce(published_at, dead_lettered_at) < ?`,
      [cutoff]
    );
    return Number(rows[0]?.count ?? 0);
  }

  private async archiveInbox(em: EntityManager, cutoff: Date, batchSize: number): Promise<number> {
    let total = 0;
    for (;;) {
      const archived = await em.transactional(async (tx) => {
        const rows = await tx.execute<{ archived: number }[]>(ARCHIVE_INBOX_BATCH, [
          cutoff,
          batchSize
        ]);
        return rows.length;
      });
      total += archived;
      if (archived < batchSize) {
        return total;
      }
    }
  }

  private async archiveOutbox(em: EntityManager, cutoff: Date, batchSize: number): Promise<number> {
    let total = 0;
    for (;;) {
      const archived = await em.transactional(async (tx) => {
        const rows = await tx.execute<{ archived: number }[]>(ARCHIVE_OUTBOX_BATCH, [
          cutoff,
          batchSize
        ]);
        return rows.length;
      });
      total += archived;
      if (archived < batchSize) {
        return total;
      }
    }
  }
}
