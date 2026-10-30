import { Migration } from '@mikro-orm/migrations';

export class Migration20261027140000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table inbox_messages_archive
        add constraint chk_inbox_archive_message_length
          check (char_length(message_id) between 1 and 255),
        add constraint chk_inbox_archive_consumer_length
          check (char_length(consumer_name) between 1 and 255),
        add constraint chk_inbox_archive_correlation_length
          check (correlation_id is null or char_length(correlation_id) between 1 and 255),
        add constraint chk_inbox_archive_payload_hash
          check (payload_hash ~ '^[0-9a-f]{64}$'),
        add constraint chk_inbox_archive_processed_at
          check (processed_at is null or processed_at >= received_at),
        add constraint chk_inbox_archive_archived_at
          check (archived_at >= received_at)
    `);

    this.addSql(`
      alter table outbox_messages_archive
        add constraint chk_outbox_archive_event_type_length
          check (char_length(event_type) between 1 and 255),
        add constraint chk_outbox_archive_correlation_length
          check (correlation_id is null or char_length(correlation_id) between 1 and 255),
        add constraint chk_outbox_archive_attempts
          check (attempts >= 0),
        add constraint chk_outbox_archive_claim_count
          check (claim_count >= 0),
        add constraint chk_outbox_archive_published_or_dead_lettered
          check (published_at is null or dead_lettered_at is null),
        add constraint chk_outbox_archive_published_at
          check (published_at is null or published_at >= occurred_at),
        add constraint chk_outbox_archive_next_attempt_at
          check (next_attempt_at >= occurred_at),
        add constraint chk_outbox_archive_archived_at
          check (archived_at >= occurred_at)
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table outbox_messages_archive
        drop constraint if exists chk_outbox_archive_archived_at,
        drop constraint if exists chk_outbox_archive_next_attempt_at,
        drop constraint if exists chk_outbox_archive_published_at,
        drop constraint if exists chk_outbox_archive_published_or_dead_lettered,
        drop constraint if exists chk_outbox_archive_claim_count,
        drop constraint if exists chk_outbox_archive_attempts,
        drop constraint if exists chk_outbox_archive_correlation_length,
        drop constraint if exists chk_outbox_archive_event_type_length
    `);
    this.addSql(`
      alter table inbox_messages_archive
        drop constraint if exists chk_inbox_archive_archived_at,
        drop constraint if exists chk_inbox_archive_processed_at,
        drop constraint if exists chk_inbox_archive_payload_hash,
        drop constraint if exists chk_inbox_archive_correlation_length,
        drop constraint if exists chk_inbox_archive_consumer_length,
        drop constraint if exists chk_inbox_archive_message_length
    `);
  }
}
