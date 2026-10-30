import { WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { WagerTransactionStatus } from '../wager-transaction/wager-transaction-status';
import { WagerTransaction } from '../wager-transaction/wager-transaction';
import { EventContext, IntegrationEvent } from './integration-event';
import { WagerTransactionPendingReference } from './wager-transaction-pending-reference';
import { WagerTransactionProcessed } from './wager-transaction-processed';
import { WagerTransactionRejected } from './wager-transaction-rejected';
import { WalletBalanceChanged } from './wallet-balance-changed';

export function mapTransactionEvents(
  transaction: WagerTransaction,
  entry: WalletLedgerEntry | undefined,
  ctx: EventContext
): IntegrationEvent<unknown>[] {
  switch (transaction.status) {
    case WagerTransactionStatus.Processed: {
      const events: IntegrationEvent<unknown>[] = [
        WagerTransactionProcessed.from(transaction, ctx)
      ];
      if (transaction.affectsBalance()) {
        if (entry === undefined) {
          throw new Error('Processed transaction with balance effect requires a ledger entry');
        }
        if (entry.transactionId !== transaction.id || entry.walletId !== transaction.walletId) {
          throw new Error('Ledger entry does not belong to the transaction');
        }
        events.push(WalletBalanceChanged.from(entry, ctx));
      }
      return events;
    }
    case WagerTransactionStatus.Rejected:
      return [WagerTransactionRejected.from(transaction, ctx)];
    case WagerTransactionStatus.PendingReference:
      return [WagerTransactionPendingReference.from(transaction, ctx)];
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.Failed:
      return [];
  }
}
