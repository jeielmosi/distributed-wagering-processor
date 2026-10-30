import { Migration } from '@mikro-orm/migrations';

export class Migration20261026190000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        add constraint chk_wager_tx_balance_after_non_negative
        check (balance_after_amount is null or balance_after_amount >= 0)
    `);

    this.addSql(`
      alter table wager_transactions
        add constraint fk_wager_tx_reference_wallet
        foreign key (wallet_id, reference_transaction_id)
        references wager_transactions (wallet_id, id)
    `);

    this.addSql(`
      create or replace function prevent_terminal_wager_transaction_modification()
      returns trigger as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'Wager transactions in terminal state % are immutable', old.status;
        end if;
        if tg_op = 'DELETE' then
          return old;
        end if;
        return new;
      end;
      $$ language plpgsql
    `);

    this.addSql(`
      create trigger trg_prevent_terminal_wager_transaction_modification
        before update or delete on wager_transactions
        for each row execute function prevent_terminal_wager_transaction_modification()
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      'drop trigger if exists trg_prevent_terminal_wager_transaction_modification on wager_transactions'
    );
    this.addSql('drop function if exists prevent_terminal_wager_transaction_modification()');
    this.addSql(
      'alter table wager_transactions drop constraint if exists fk_wager_tx_reference_wallet'
    );
    this.addSql(
      'alter table wager_transactions drop constraint if exists chk_wager_tx_balance_after_non_negative'
    );
  }
}
