import { EntityProperty, Platform, Type } from '@mikro-orm/core';

export class MoneyAmountType extends Type<string, string> {
  override convertToJSValue(value: string): string {
    const raw: unknown = value;
    if (raw === null || raw === undefined) {
      return raw as unknown as string;
    }
    if (typeof raw !== 'string') {
      throw new TypeError('Monetary amounts must be read from PostgreSQL as strings');
    }
    return raw;
  }

  override convertToDatabaseValue(value: string): string {
    const raw: unknown = value;
    if (raw === null || raw === undefined) {
      return raw as unknown as string;
    }
    if (typeof raw !== 'string') {
      throw new TypeError('Monetary amounts must be written to PostgreSQL as strings');
    }
    return raw;
  }

  override getColumnType(_prop: EntityProperty, _platform: Platform): string {
    return 'numeric(18,2)';
  }
}
