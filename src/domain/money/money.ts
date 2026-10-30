import Decimal from 'decimal.js';
import { isSupportedCurrency, normalizeCurrency } from '../../shared/currency/iso-4217';
import { CurrencyMismatchError, InvalidMoneyError } from './money.errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;
const MAX_AMOUNT = new Decimal('9999999999999999.99');

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string
  ) {}

  static from(props: MoneyProps): Money {
    const currency = normalizeCurrency(props.currency);
    if (!isSupportedCurrency(currency)) {
      throw new InvalidMoneyError(`Unsupported ISO-4217 currency: ${props.currency}`);
    }
    if (typeof props.amount !== 'string' || !AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(`Invalid monetary amount: ${String(props.amount)}`);
    }
    const value = new Decimal(props.amount);
    if (!value.isFinite()) {
      throw new InvalidMoneyError(`Invalid monetary amount: ${props.amount}`);
    }
    if (value.greaterThan(MAX_AMOUNT)) {
      throw new InvalidMoneyError(`Monetary amount exceeds NUMERIC(18,2): ${props.amount}`);
    }
    return new Money(value, currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return this.withinRange(this.value.plus(other.value));
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return this.withinRange(this.value.minus(other.value));
  }

  negate(): Money {
    return this.withinRange(this.value.negated());
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  private withinRange(value: Decimal): Money {
    if (value.abs().greaterThan(MAX_AMOUNT)) {
      throw new InvalidMoneyError('Monetary amount exceeds NUMERIC(18,2)');
    }
    return new Money(value, this.currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
