import { Migration } from '@mikro-orm/migrations';

export class Migration20261027120001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create or replace function assert_wallet_ledger_consistency()
      returns trigger as $$
      declare
        v_wallet_id uuid;
        v_wallet_balance numeric(18,2);
        v_wallet_version integer;
        v_wallet_currency varchar(3);
        v_ledger_sum numeric(18,2);
        v_ledger_count integer;
        v_min_version integer;
        v_max_version integer;
        v_last_balance numeric(18,2);
        v_last_currency varchar(3);
        v_last_version integer;
      begin
        if tg_table_name = 'wallets' then
          v_wallet_id := new.id;
        else
          v_wallet_id := new.wallet_id;
        end if;

        select w.balance_amount, w.version, w.currency
          into v_wallet_balance, v_wallet_version, v_wallet_currency
          from wallets w
         where w.id = v_wallet_id;

        if not found then
          raise exception 'wallet ledger consistency: wallet % does not exist', v_wallet_id;
        end if;

        select count(*),
               min(e.wallet_version),
               max(e.wallet_version),
               coalesce(sum(case when e.direction = 'CREDIT' then e.amount else -e.amount end), 0)
          into v_ledger_count, v_min_version, v_max_version, v_ledger_sum
          from wallet_ledger_entries e
         where e.wallet_id = v_wallet_id;

        select e.balance_after_amount, e.currency, e.wallet_version
          into v_last_balance, v_last_currency, v_last_version
          from wallet_ledger_entries e
         where e.wallet_id = v_wallet_id
         order by e.wallet_version desc
         limit 1;

        if not found then
          if v_wallet_balance <> 0 or v_wallet_version <> 1 then
            raise exception 'wallet ledger consistency: wallet % has balance % and version % without ledger entries',
              v_wallet_id, v_wallet_balance, v_wallet_version;
          end if;
          return null;
        end if;

        if v_max_version - v_min_version + 1 <> v_ledger_count then
          raise exception 'wallet ledger consistency: wallet % has a gap in wallet_version (min %, max %, count %)',
            v_wallet_id, v_min_version, v_max_version, v_ledger_count;
        end if;

        if v_last_balance <> v_wallet_balance
           or v_last_version <> v_wallet_version
           or v_ledger_sum <> v_wallet_balance
           or v_last_currency <> v_wallet_currency then
          raise exception 'wallet ledger consistency: wallet % balance %, version %, ledger sum %, last ledger balance %, last ledger version %, last ledger currency %',
            v_wallet_id, v_wallet_balance, v_wallet_version, v_ledger_sum,
            v_last_balance, v_last_version, v_last_currency;
        end if;

        return null;
      end;
      $$ language plpgsql
    `);

    this.addSql(`
      create constraint trigger trg_wallets_ledger_consistency
        after insert or update on wallets
        deferrable initially deferred
        for each row execute function assert_wallet_ledger_consistency()
    `);
    this.addSql(`
      create constraint trigger trg_ledger_wallet_consistency
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function assert_wallet_ledger_consistency()
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop trigger if exists trg_ledger_wallet_consistency on wallet_ledger_entries');
    this.addSql('drop trigger if exists trg_wallets_ledger_consistency on wallets');
    this.addSql('drop function if exists assert_wallet_ledger_consistency()');
  }
}
