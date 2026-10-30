import { Migration } from '@mikro-orm/migrations';

export class Migration20261027120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table inbox_messages_archive (
        archive_id bigserial primary key,
        message_id varchar(255) not null,
        consumer_name varchar(255) not null,
        payload_hash char(64) not null,
        correlation_id varchar(255) null,
        received_at timestamptz not null,
        processed_at timestamptz null,
        archived_at timestamptz not null default now()
      )
    `);
    this.addSql(`
      create index idx_inbox_archive_identity
        on inbox_messages_archive (consumer_name, message_id)
    `);
    this.addSql(`
      create index idx_inbox_archive_archived_at
        on inbox_messages_archive (archived_at)
    `);

    this.addSql(`
      create table outbox_messages_archive (
        archive_id bigserial primary key,
        id uuid not null,
        aggregate_id uuid not null,
        event_type varchar(255) not null,
        payload jsonb not null,
        correlation_id varchar(255) null,
        occurred_at timestamptz not null,
        attempts integer not null,
        claim_count integer not null,
        next_attempt_at timestamptz not null,
        published_at timestamptz null,
        dead_lettered_at timestamptz null,
        last_error text null,
        archived_at timestamptz not null default now()
      )
    `);
    this.addSql(`
      create index idx_outbox_archive_id
        on outbox_messages_archive (id)
    `);
    this.addSql(`
      create index idx_outbox_archive_archived_at
        on outbox_messages_archive (archived_at)
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists outbox_messages_archive');
    this.addSql('drop table if exists inbox_messages_archive');
  }
}
