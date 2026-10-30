import { Money } from '../../domain/money/money';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { TransactionContext } from './transaction-context';

export interface LedgerEntryRepository {
  save(entry: WalletLedgerEntry, ctx?: TransactionContext): Promise<void>;
  findByWalletIdCursor(
    walletId: string,
    walletVersionCursor: number | undefined,
    limit: number,
    ctx?: TransactionContext
  ): Promise<WalletLedgerEntry[]>;
  findByWalletIdOrdered(walletId: string, ctx?: TransactionContext): Promise<WalletLedgerEntry[]>;
  sumByWalletId(walletId: string, ctx?: TransactionContext): Promise<Money | undefined>;
}
