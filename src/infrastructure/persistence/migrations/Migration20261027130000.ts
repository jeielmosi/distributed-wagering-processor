import { Migration } from '@mikro-orm/migrations';

const FAILURE_CODES = [
  'INSUFFICIENT_FUNDS',
  'INSUFFICIENT_FUNDS_FOR_REVERSAL',
  'REFERENCE_REQUIRED',
  'REFERENCE_NOT_FOUND',
  'REFERENCE_NOT_PROCESSED',
  'REFERENCE_ALREADY_REVERTED',
  'REFERENCE_ALREADY_SETTLED',
  'REFERENCE_HAS_PROCESSED_WIN',
  'REFERENCE_AMOUNT_MISMATCH',
  'REFERENCE_CONTEXT_MISMATCH',
  'INVALID_REFERENCE_KIND',
  'IDEMPOTENCY_PAYLOAD_MISMATCH',
  'CURRENCY_MISMATCH',
  'INVALID_PAYLOAD',
  'WALLET_NOT_FOUND',
  'WALLET_PLAYER_MISMATCH',
  'WALLET_ALREADY_EXISTS',
  'DUPLICATE_EXTERNAL_TRANSACTION',
  'OPENING_NOT_ALLOWED',
  'PERMANENT_INFRA_FAILURE'
];

function failureCodeList(codes: string[]): string {
  return codes.map((code) => `'${code}'`).join(',');
}

export class Migration20261027130000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      'alter table wager_transactions drop constraint if exists chk_wager_tx_failure_code'
    );
    this.addSql(`
      alter table wager_transactions
        add constraint chk_wager_tx_failure_code check (
          failure_code is null or failure_code in (${failureCodeList(FAILURE_CODES)})
        )
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      'alter table wager_transactions disable trigger trg_prevent_terminal_wager_transaction_modification'
    );
    this.addSql(
      "update wager_transactions set failure_code = 'PERMANENT_INFRA_FAILURE' where failure_code = 'REFERENCE_REQUIRED'"
    );
    this.addSql(
      'alter table wager_transactions enable trigger trg_prevent_terminal_wager_transaction_modification'
    );
    this.addSql(
      'alter table wager_transactions drop constraint if exists chk_wager_tx_failure_code'
    );
    this.addSql(`
      alter table wager_transactions
        add constraint chk_wager_tx_failure_code check (
          failure_code is null or failure_code in (${failureCodeList(
            FAILURE_CODES.filter((code) => code !== 'REFERENCE_REQUIRED')
          )})
        )
    `);
  }
}
