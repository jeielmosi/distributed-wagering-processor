import { newUuidV7 } from '../../shared/id/uuid';
import { ZeroMovementError } from '../../shared/errors/zero-movement-error';
import { LedgerDirection } from '../ledger/ledger-direction';
import { WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';
import { CurrencyMismatchError } from '../money/money.errors';
import { InsufficientBalanceError, InvalidWalletError } from './wallet.errors';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at?: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovementProps {
  transactionId: string;
  money: Money;
  at?: Date;
  entryId?: string;
}

export interface WalletMovementResult {
  wallet: Wallet;
  entry: WalletLedgerEntry;
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidWalletError(`${field} must be a non-empty string`);
  }
}

export class Wallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly createdAt: Date;
  private _balance: Money;
  private _version: number;
  private _loadedVersion: number;
  private _updatedAt: Date;

  private constructor(props: WalletState) {
    this.id = props.id;
    this.playerId = props.playerId;
    this.currency = props.currency;
    this._balance = props.balance;
    this._version = props.version;
    this._loadedVersion = props.version;
    this.createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  static open(props: OpenWalletProps): Wallet {
    assertNonEmpty(props.id, 'id');
    assertNonEmpty(props.playerId, 'playerId');
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError('initialBalance must not be negative');
    }
    const at = props.at ?? new Date();
    return new Wallet({
      id: props.id,
      playerId: props.playerId,
      currency: props.initialBalance.currency,
      balance: props.initialBalance,
      version: 1,
      createdAt: at,
      updatedAt: at
    });
  }

  static rehydrate(state: WalletState): Wallet {
    assertNonEmpty(state.id, 'id');
    assertNonEmpty(state.playerId, 'playerId');
    if (!Number.isInteger(state.version) || state.version < 1) {
      throw new InvalidWalletError('version must be an integer greater than or equal to 1');
    }
    if (state.balance.isNegative()) {
      throw new InvalidWalletError('balance must not be negative');
    }
    if (state.balance.currency !== state.currency) {
      throw new InvalidWalletError('balance currency must match wallet currency');
    }
    return new Wallet(state);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get loadedVersion(): number {
    return this._loadedVersion;
  }

  markPersisted(): void {
    this._loadedVersion = this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(props: WalletMovementProps): WalletMovementResult {
    this.validateMovement(props);
    if (this._balance.isLessThan(props.money)) {
      throw new InsufficientBalanceError();
    }
    return this.applyMovement(LedgerDirection.Debit, props, this._balance.subtract(props.money));
  }

  credit(props: WalletMovementProps): WalletMovementResult {
    this.validateMovement(props);
    return this.applyMovement(LedgerDirection.Credit, props, this._balance.add(props.money));
  }

  private validateMovement(props: WalletMovementProps): void {
    assertNonEmpty(props.transactionId, 'transactionId');
    if (props.money.isNegative()) {
      throw new InvalidWalletError('Movement money must not be negative');
    }
    if (props.money.isZero()) {
      throw new ZeroMovementError();
    }
    if (props.money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, props.money.currency);
    }
  }

  private applyMovement(
    direction: LedgerDirection,
    props: WalletMovementProps,
    balanceAfter: Money
  ): WalletMovementResult {
    const at = props.at ?? new Date();
    const versionAfter = this._version + 1;
    const entry = WalletLedgerEntry.create({
      id: props.entryId ?? newUuidV7(),
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter,
      walletVersion: versionAfter,
      createdAt: at
    });

    this._balance = balanceAfter;
    this._version = versionAfter;
    this._updatedAt = at;

    return { wallet: this, entry };
  }
}
