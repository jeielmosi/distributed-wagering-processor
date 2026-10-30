import type { FailureCode } from '../../shared/errors/failure-code';
import type { LedgerDirection } from '../../domain/ledger/ledger-direction';
import type { MoneyProps } from '../../domain/money/money';
import type { WagerTransactionKind } from '../../domain/wager-transaction/wager-transaction-kind';
import type { WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction-status';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPageView {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export interface TransactionView {
  transactionId: string;
  providerId: string | null;
  externalTransactionId: string | null;
  playerId: string;
  walletId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  balanceAfter: MoneyProps | null;
  failureCode: FailureCode | null;
  referenceTransactionId: string | null;
  createdAt: string;
  processedAt: string | null;
  resolvedAt: string | null;
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}
