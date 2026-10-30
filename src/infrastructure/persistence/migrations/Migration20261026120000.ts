import { Migration } from '@mikro-orm/migrations';

export class Migration20261026120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency varchar(3) not null,
        balance_amount numeric(18,2) not null,
        version integer not null default 1,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint uq_wallets_player_currency unique (player_id, currency),
        constraint chk_wallets_balance_non_negative check (balance_amount >= 0),
        constraint chk_wallets_version check (version >= 1),
        constraint chk_wallets_currency check (currency ~ '^[A-Z]{3}$'),
        constraint chk_wallets_updated_at check (updated_at >= created_at)
      )
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id varchar(255) null,
        external_transaction_id varchar(255) null,
        idempotency_key varchar(255) not null,
        payload_hash char(64) not null,
        wallet_id uuid not null,
        player_id uuid not null,
        round_id varchar(255) null,
        game_id varchar(255) null,
        kind varchar(16) not null,
        amount numeric(18,2) not null,
        currency varchar(3) not null,
        balance_after_amount numeric(18,2) null,
        balance_after_currency varchar(3) null,
        reference_external_transaction_id varchar(255) null,
        reference_transaction_id uuid null,
        status varchar(32) not null,
        failure_code varchar(64) null,
        correlation_id varchar(255) null,
        causation_id varchar(255) null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        processed_at timestamptz null,
        resolved_at timestamptz null,
        reference_attempts integer not null default 0,
        next_reference_attempt_at timestamptz null,
        reference_expires_at timestamptz null,
        reference_last_attempt_at timestamptz null,
        constraint fk_wager_tx_wallet foreign key (wallet_id) references wallets (id),
        constraint fk_wager_tx_reference foreign key (reference_transaction_id) references wager_transactions (id),
        constraint uq_wager_tx_provider_external unique (provider_id, external_transaction_id),
        constraint uq_wager_tx_wallet_id unique (wallet_id, id),
        constraint chk_wager_tx_kind check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        constraint chk_wager_tx_status check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        constraint chk_wager_tx_kind_fields check (
          (kind = 'OPENING' and provider_id is null and external_transaction_id is null and round_id is null and game_id is null)
          or (kind <> 'OPENING' and provider_id is not null and external_transaction_id is not null and round_id is not null and game_id is not null)
        ),
        constraint chk_wager_tx_opening_idempotency check (
          kind <> 'OPENING' or idempotency_key = 'internal:opening:' || wallet_id::text
        ),
        constraint chk_wager_tx_amount check (amount > 0),
        constraint chk_wager_tx_currency check (currency ~ '^[A-Z]{3}$'),
        constraint chk_wager_tx_idempotency_length check (char_length(idempotency_key) between 1 and 255),
        constraint chk_wager_tx_payload_hash check (payload_hash ~ '^[0-9a-f]{64}$'),
        constraint chk_wager_tx_provider_length check (provider_id is null or char_length(provider_id) between 1 and 255),
        constraint chk_wager_tx_external_length check (external_transaction_id is null or char_length(external_transaction_id) between 1 and 255),
        constraint chk_wager_tx_round_length check (round_id is null or char_length(round_id) between 1 and 255),
        constraint chk_wager_tx_game_length check (game_id is null or char_length(game_id) between 1 and 255),
        constraint chk_wager_tx_reference_external_length check (
          reference_external_transaction_id is null or char_length(reference_external_transaction_id) between 1 and 255
        ),
        constraint chk_wager_tx_correlation_length check (correlation_id is null or char_length(correlation_id) between 1 and 255),
        constraint chk_wager_tx_causation_length check (causation_id is null or char_length(causation_id) between 1 and 255),
        constraint chk_wager_tx_balance_after_currency check (
          balance_after_currency is null or balance_after_currency ~ '^[A-Z]{3}$'
        ),
        constraint chk_wager_tx_reference_attempts check (reference_attempts >= 0),
        constraint chk_wager_tx_balance_after_pair check (
          (balance_after_amount is null) = (balance_after_currency is null)
        ),
        constraint chk_wager_tx_processed_snapshot check (
          status <> 'PROCESSED'
          or (balance_after_amount is not null and balance_after_currency is not null and processed_at is not null)
        ),
        constraint chk_wager_tx_non_processed_snapshot check (
          status = 'PROCESSED'
          or (balance_after_amount is null and balance_after_currency is null and processed_at is null)
        ),
        constraint chk_wager_tx_updated_at check (updated_at >= created_at),
        constraint chk_wager_tx_resolved_at check (resolved_at is null or resolved_at >= created_at),
        constraint chk_wager_tx_resolved_state check (
          (status in ('PROCESSED','REJECTED','FAILED') and resolved_at is not null)
          or (status not in ('PROCESSED','REJECTED','FAILED') and resolved_at is null)
        ),
        constraint chk_wager_tx_failure_code_state check (
          (status in ('REJECTED','FAILED') and failure_code is not null)
          or (status not in ('REJECTED','FAILED') and failure_code is null)
        ),
        constraint chk_wager_tx_pending_reference_fields check (
          status <> 'PENDING_REFERENCE'
          or (next_reference_attempt_at is not null and reference_expires_at is not null)
        ),
        constraint chk_wager_tx_non_pending_reference_fields check (
          status = 'PENDING_REFERENCE'
          or (next_reference_attempt_at is null and reference_expires_at is null)
        ),
        constraint chk_wager_tx_pending_reference_order check (
          status <> 'PENDING_REFERENCE' or next_reference_attempt_at <= reference_expires_at
        ),
        constraint chk_wager_tx_reference_expires check (
          reference_expires_at is null or reference_expires_at >= created_at
        ),
        constraint chk_wager_tx_reference_by_kind check (
          (kind in ('REFUND','ROLLBACK') and reference_external_transaction_id is not null)
          or (kind = 'OPENING' and reference_external_transaction_id is null)
          or kind in ('BET','WIN','LOSS')
        ),
        constraint chk_wager_tx_bet_reference check (
          kind <> 'BET' or reference_external_transaction_id is null
        ),
        constraint chk_wager_tx_self_reference check (
          reference_transaction_id is null or reference_transaction_id <> id
        ),
        constraint chk_wager_tx_reversal_reference check (
          status <> 'PROCESSED'
          or kind not in ('REFUND','ROLLBACK')
          or reference_transaction_id is not null
        ),
        constraint chk_wager_tx_failure_code check (
          failure_code is null or failure_code in (
            'INSUFFICIENT_FUNDS','INSUFFICIENT_FUNDS_FOR_REVERSAL','REFERENCE_NOT_FOUND',
            'REFERENCE_NOT_PROCESSED','REFERENCE_ALREADY_REVERTED','REFERENCE_ALREADY_SETTLED',
            'REFERENCE_HAS_PROCESSED_WIN','REFERENCE_AMOUNT_MISMATCH','REFERENCE_CONTEXT_MISMATCH',
            'INVALID_REFERENCE_KIND','IDEMPOTENCY_PAYLOAD_MISMATCH','CURRENCY_MISMATCH',
            'INVALID_PAYLOAD','WALLET_NOT_FOUND','WALLET_PLAYER_MISMATCH','WALLET_ALREADY_EXISTS',
            'DUPLICATE_EXTERNAL_TRANSACTION','OPENING_NOT_ALLOWED','PERMANENT_INFRA_FAILURE'
          )
        )
      )
    `);

    this.addSql(`
      create unique index uq_wager_tx_idempotency_provider
        on wager_transactions (provider_id, idempotency_key)
        where provider_id is not null
    `);
    this.addSql(`
      create unique index uq_wager_tx_idempotency_opening
        on wager_transactions (idempotency_key)
        where kind = 'OPENING'
    `);
    this.addSql(`
      create unique index uq_wager_tx_opening_wallet
        on wager_transactions (wallet_id)
        where kind = 'OPENING'
    `);
    this.addSql(`
      create index idx_wager_tx_wallet_status
        on wager_transactions (wallet_id, status)
    `);
    this.addSql(`
      create index idx_wager_tx_provider_reference
        on wager_transactions (provider_id, reference_external_transaction_id)
    `);
    this.addSql(`
      create index idx_wager_tx_pending_due
        on wager_transactions (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE'
    `);
    this.addSql(`
      create unique index uq_wager_tx_reversal
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED'
          and kind in ('REFUND','ROLLBACK')
          and reference_transaction_id is not null
    `);
    this.addSql(`
      create unique index uq_wager_tx_settlement
        on wager_transactions (provider_id, reference_external_transaction_id)
        where status = 'PROCESSED'
          and kind in ('WIN','LOSS')
          and reference_external_transaction_id is not null
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null,
        transaction_id uuid not null,
        wallet_version integer not null,
        direction varchar(8) not null,
        amount numeric(18,2) not null,
        currency varchar(3) not null,
        balance_before_amount numeric(18,2) not null,
        balance_after_amount numeric(18,2) not null,
        created_at timestamptz not null default now(),
        constraint uq_ledger_wallet_transaction unique (wallet_id, transaction_id),
        constraint uq_ledger_wallet_version unique (wallet_id, wallet_version),
        constraint fk_ledger_wallet foreign key (wallet_id) references wallets (id),
        constraint fk_ledger_transaction foreign key (wallet_id, transaction_id) references wager_transactions (wallet_id, id),
        constraint chk_ledger_direction check (direction in ('DEBIT','CREDIT')),
        constraint chk_ledger_amount check (amount > 0),
        constraint chk_ledger_balances check (balance_before_amount >= 0 and balance_after_amount >= 0),
        constraint chk_ledger_arithmetic check (
          (direction = 'DEBIT' and balance_after_amount = balance_before_amount - amount)
          or (direction = 'CREDIT' and balance_after_amount = balance_before_amount + amount)
        ),
        constraint chk_ledger_currency check (currency ~ '^[A-Z]{3}$'),
        constraint chk_ledger_wallet_version check (wallet_version >= 1)
      )
    `);
    this.addSql(`
      create index idx_ledger_wallet_pagination
        on wallet_ledger_entries (wallet_id, wallet_version desc)
    `);

    this.addSql(`
      create table inbox_messages (
        message_id varchar(255) not null,
        consumer_name varchar(255) not null,
        payload_hash char(64) not null,
        correlation_id varchar(255) null,
        received_at timestamptz not null default now(),
        processed_at timestamptz null,
        constraint pk_inbox_messages primary key (consumer_name, message_id),
        constraint chk_inbox_processed_at check (processed_at is null or processed_at >= received_at),
        constraint chk_inbox_message_length check (char_length(message_id) between 1 and 255),
        constraint chk_inbox_consumer_length check (char_length(consumer_name) between 1 and 255),
        constraint chk_inbox_correlation_length check (correlation_id is null or char_length(correlation_id) between 1 and 255),
        constraint chk_inbox_payload_hash check (payload_hash ~ '^[0-9a-f]{64}$')
      )
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type varchar(255) not null,
        payload jsonb not null,
        correlation_id varchar(255) null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        claim_count integer not null default 0,
        next_attempt_at timestamptz not null,
        published_at timestamptz null,
        dead_lettered_at timestamptz null,
        last_error text null,
        constraint chk_outbox_attempts check (attempts >= 0),
        constraint chk_outbox_claim_count check (claim_count >= 0),
        constraint chk_outbox_event_type_length check (char_length(event_type) between 1 and 255),
        constraint chk_outbox_correlation_length check (correlation_id is null or char_length(correlation_id) between 1 and 255),
        constraint chk_outbox_published_or_dead_lettered check (published_at is null or dead_lettered_at is null),
        constraint chk_outbox_published_at check (published_at is null or published_at >= occurred_at),
        constraint chk_outbox_next_attempt_at check (next_attempt_at >= occurred_at)
      )
    `);
    this.addSql(`
      create index idx_outbox_pending
        on outbox_messages (next_attempt_at)
        where published_at is null and dead_lettered_at is null
    `);

    this.addSql(`
      create or replace function set_updated_at()
      returns trigger as $$
      begin
        new.updated_at = now();
        return new;
      end;
      $$ language plpgsql
    `);
    this.addSql(`
      create trigger trg_wallets_set_updated_at
        before insert or update on wallets
        for each row execute function set_updated_at()
    `);
    this.addSql(`
      create trigger trg_wager_transactions_set_updated_at
        before insert or update on wager_transactions
        for each row execute function set_updated_at()
    `);

    this.addSql(`
      create or replace function prevent_ledger_modification()
      returns trigger as $$
      begin
        raise exception 'Wallet ledger entries are immutable and cannot be updated or deleted.';
      end;
      $$ language plpgsql
    `);
    this.addSql(`
      create trigger trg_prevent_ledger_modification
        before update or delete on wallet_ledger_entries
        for each row execute function prevent_ledger_modification()
    `);
    this.addSql(`
      create trigger trg_prevent_ledger_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function prevent_ledger_modification()
    `);

    this.addSql('revoke truncate on wallet_ledger_entries from public');
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists outbox_messages');
    this.addSql('drop table if exists inbox_messages');
    this.addSql('drop table if exists wallet_ledger_entries');
    this.addSql('drop table if exists wager_transactions');
    this.addSql('drop table if exists wallets');
    this.addSql('drop function if exists set_updated_at()');
    this.addSql('drop function if exists prevent_ledger_modification()');
  }
}
