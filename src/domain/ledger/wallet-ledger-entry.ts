import { ZeroMovementError } from '../../shared/errors/zero-movement-error';
import { Money } from '../money/money';
import { LedgerDirection } from './ledger-direction';
import { InvalidLedgerEntryError } from './ledger.errors';

export { LedgerDirection } from './ledger-direction';

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  walletVersion: number;
  createdAt?: Date;
}

export interface WalletLedgerEntryState extends CreateLedgerEntryProps {
  createdAt: Date;
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidLedgerEntryError(`${field} must be a non-empty string`);
  }
}

export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly walletVersion: number;
  readonly createdAt: Date;

  private constructor(props: WalletLedgerEntryState) {
    this.id = props.id;
    this.walletId = props.walletId;
    this.transactionId = props.transactionId;
    this.direction = props.direction;
    this.money = props.money;
    this.balanceBefore = props.balanceBefore;
    this.balanceAfter = props.balanceAfter;
    this.walletVersion = props.walletVersion;
    this.createdAt = props.createdAt;
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    assertNonEmpty(props.id, 'id');
    assertNonEmpty(props.walletId, 'walletId');
    assertNonEmpty(props.transactionId, 'transactionId');

    if (props.direction !== LedgerDirection.Debit && props.direction !== LedgerDirection.Credit) {
      throw new InvalidLedgerEntryError(`Invalid ledger direction: ${String(props.direction)}`);
    }
    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvalidLedgerEntryError(
        'walletVersion must be an integer greater than or equal to 1'
      );
    }
    if (
      props.money.isNegative() ||
      props.balanceBefore.isNegative() ||
      props.balanceAfter.isNegative()
    ) {
      throw new InvalidLedgerEntryError('Ledger amounts must not be negative');
    }
    if (props.money.isZero()) {
      throw new ZeroMovementError();
    }

    const currencies = new Set([
      props.money.currency,
      props.balanceBefore.currency,
      props.balanceAfter.currency
    ]);
    if (currencies.size !== 1) {
      throw new InvalidLedgerEntryError('All ledger amounts must share the same currency');
    }

    if (props.direction === LedgerDirection.Debit) {
      if (props.balanceBefore.isLessThan(props.money)) {
        throw new InvalidLedgerEntryError('Debit amount exceeds balanceBefore');
      }
      if (!props.balanceBefore.subtract(props.money).equals(props.balanceAfter)) {
        throw new InvalidLedgerEntryError('Debit entry is not balanced');
      }
    } else if (!props.balanceBefore.add(props.money).equals(props.balanceAfter)) {
      throw new InvalidLedgerEntryError('Credit entry is not balanced');
    }

    return new WalletLedgerEntry({
      ...props,
      createdAt: props.createdAt ?? new Date()
    });
  }

  static rehydrate(state: WalletLedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  isBalanced(): boolean {
    try {
      if (this.money.isZero() || this.money.isNegative()) {
        return false;
      }
      if (this.direction === LedgerDirection.Debit) {
        return (
          !this.balanceBefore.isLessThan(this.money) &&
          this.balanceBefore.subtract(this.money).equals(this.balanceAfter)
        );
      }
      if (this.direction === LedgerDirection.Credit) {
        return this.balanceBefore.add(this.money).equals(this.balanceAfter);
      }
      return false;
    } catch {
      return false;
    }
  }
}
