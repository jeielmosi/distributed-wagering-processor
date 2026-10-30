import { describe, expect, test } from 'bun:test';
import { Money } from '../money/money';
import { ZeroMovementError } from '../../shared/errors/zero-movement-error';
import { InvalidLedgerEntryError } from './ledger.errors';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const baseProps = {
  id: '0192f291-27dd-7d3f-8071-5f8685deef37',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef38',
  transactionId: '0192f291-27dd-7d3f-8071-5f8685deef39',
  balanceBefore: brl('100.00'),
  walletVersion: 2,
  createdAt: new Date('2026-07-29T15:00:00.000Z')
};

describe('WalletLedgerEntry', () => {
  test('cria entrada DEBIT com aritmética exata', () => {
    const entry = WalletLedgerEntry.create({
      ...baseProps,
      direction: LedgerDirection.Debit,
      money: brl('25.00'),
      balanceAfter: brl('75.00')
    });

    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.money.toString()).toBe('25.00');
    expect(entry.balanceAfter.toString()).toBe('75.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  test('cria entrada CREDIT com aritmética exata', () => {
    const entry = WalletLedgerEntry.create({
      ...baseProps,
      direction: LedgerDirection.Credit,
      money: brl('25.00'),
      balanceAfter: brl('125.00')
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.toString()).toBe('125.00');
  });

  test('aceita walletVersion 1 para OPENING', () => {
    const entry = WalletLedgerEntry.create({
      ...baseProps,
      walletVersion: 1,
      direction: LedgerDirection.Credit,
      money: brl('100.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('100.00')
    });

    expect(entry.walletVersion).toBe(1);
    expect(entry.isBalanced()).toBe(true);
  });

  test('rejeita DEBIT não balanceado', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...baseProps,
        direction: LedgerDirection.Debit,
        money: brl('25.00'),
        balanceAfter: brl('80.00')
      })
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejeita CREDIT não balanceado', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...baseProps,
        direction: LedgerDirection.Credit,
        money: brl('25.00'),
        balanceAfter: brl('120.00')
      })
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejeita DEBIT maior que o saldo anterior', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...baseProps,
        balanceBefore: brl('10.00'),
        direction: LedgerDirection.Debit,
        money: brl('25.00'),
        balanceAfter: brl('15.00').negate()
      })
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejeita movimentação zero', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...baseProps,
        direction: LedgerDirection.Credit,
        money: brl('0.00'),
        balanceAfter: brl('100.00')
      })
    ).toThrow(ZeroMovementError);
  });

  test('rejeita movimentação negativa', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...baseProps,
        direction: LedgerDirection.Credit,
        money: brl('25.00').negate(),
        balanceAfter: brl('75.00')
      })
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejeita conflito de moeda entre valores', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...baseProps,
        direction: LedgerDirection.Credit,
        money: Money.from({ amount: '25.00', currency: 'USD' }),
        balanceAfter: brl('125.00')
      })
    ).toThrow();
  });

  test('rejeita walletVersion inválido', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...baseProps,
        walletVersion: 0,
        direction: LedgerDirection.Credit,
        money: brl('25.00'),
        balanceAfter: brl('125.00')
      })
    ).toThrow(InvalidLedgerEntryError);
  });

  test('é estruturalmente imutável', () => {
    const entry = WalletLedgerEntry.create({
      ...baseProps,
      direction: LedgerDirection.Debit,
      money: brl('25.00'),
      balanceAfter: brl('75.00')
    });

    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { walletVersion: number }).walletVersion = 3;
    }).toThrow();
    expect(entry.walletVersion).toBe(2);
  });

  test('rehydrate reconstrói o estado persistido', () => {
    const createdAt = new Date('2026-07-29T15:00:00.000Z');
    const entry = WalletLedgerEntry.rehydrate({
      ...baseProps,
      direction: LedgerDirection.Credit,
      money: brl('25.00'),
      balanceAfter: brl('125.00'),
      createdAt
    });

    expect(entry.createdAt).toBe(createdAt);
    expect(entry.isBalanced()).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
  });
});
