import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../ledger/ledger-direction';
import { Money } from '../money/money';
import { CurrencyMismatchError } from '../money/money.errors';
import { ZeroMovementError } from '../../shared/errors/zero-movement-error';
import { InsufficientBalanceError, InvalidWalletError } from './wallet.errors';
import { Wallet } from './wallet';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const transactionId = '0192f298-345e-7e38-af88-e43f851a819d';
const createdAt = new Date('2026-07-29T15:00:00.000Z');
const movementAt = new Date('2026-07-29T15:01:00.000Z');

describe('Wallet', () => {
  describe('criação', () => {
    test('abre wallet com saldo inicial e versão 1', () => {
      const wallet = Wallet.open({
        id: walletId,
        playerId,
        initialBalance: brl('100.00'),
        at: createdAt
      });

      expect(wallet.id).toBe(walletId);
      expect(wallet.playerId).toBe(playerId);
      expect(wallet.currency).toBe('BRL');
      expect(wallet.balance.toString()).toBe('100.00');
      expect(wallet.version).toBe(1);
      expect(wallet.createdAt).toBe(createdAt);
      expect(wallet.updatedAt).toBe(createdAt);
    });

    test('abre wallet com saldo inicial 0.00', () => {
      const wallet = Wallet.open({ id: walletId, playerId, initialBalance: brl('0.00') });

      expect(wallet.balance.isZero()).toBe(true);
      expect(wallet.version).toBe(1);
    });

    test('rejeita id e playerId vazios', () => {
      expect(() => Wallet.open({ id: '', playerId, initialBalance: brl('0.00') })).toThrow(
        InvalidWalletError
      );
      expect(() =>
        Wallet.open({ id: walletId, playerId: ' ', initialBalance: brl('0.00') })
      ).toThrow(InvalidWalletError);
    });
  });

  describe('movimentação', () => {
    test('débito com saldo suficiente gera lançamento DEBIT balanceado', () => {
      const wallet = Wallet.open({
        id: walletId,
        playerId,
        initialBalance: brl('100.00'),
        at: createdAt
      });

      const result = wallet.debit({ transactionId, money: brl('25.00'), at: movementAt });

      expect(result.wallet).toBe(wallet);
      expect(wallet.balance.toString()).toBe('75.00');
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toBe(movementAt);
      expect(result.entry.direction).toBe(LedgerDirection.Debit);
      expect(result.entry.money.toString()).toBe('25.00');
      expect(result.entry.balanceBefore.toString()).toBe('100.00');
      expect(result.entry.balanceAfter.toString()).toBe('75.00');
      expect(result.entry.walletVersion).toBe(2);
      expect(result.entry.transactionId).toBe(transactionId);
      expect(result.entry.walletId).toBe(walletId);
      expect(result.entry.createdAt).toBe(movementAt);
      expect(result.entry.isBalanced()).toBe(true);
    });

    test('loadedVersion acompanha a versão persistida apenas após markPersisted', () => {
      const wallet = Wallet.open({
        id: walletId,
        playerId,
        initialBalance: brl('100.00'),
        at: createdAt
      });

      wallet.debit({ transactionId, money: brl('25.00'), at: movementAt });
      expect(wallet.version).toBe(2);
      expect(wallet.loadedVersion).toBe(1);

      wallet.markPersisted();
      expect(wallet.loadedVersion).toBe(2);
    });

    test('débito com saldo insuficiente lança InsufficientBalanceError sem alterar estado', () => {
      const wallet = Wallet.open({
        id: walletId,
        playerId,
        initialBalance: brl('10.00'),
        at: createdAt
      });

      expect(() => wallet.debit({ transactionId, money: brl('25.00'), at: movementAt })).toThrow(
        InsufficientBalanceError
      );
      expect(wallet.balance.toString()).toBe('10.00');
      expect(wallet.version).toBe(1);
      expect(wallet.updatedAt).toBe(createdAt);
    });

    test('crédito gera lançamento CREDIT balanceado', () => {
      const wallet = Wallet.open({
        id: walletId,
        playerId,
        initialBalance: brl('100.00'),
        at: createdAt
      });

      const result = wallet.credit({ transactionId, money: brl('25.00'), at: movementAt });

      expect(result.wallet).toBe(wallet);
      expect(wallet.balance.toString()).toBe('125.00');
      expect(wallet.version).toBe(2);
      expect(result.entry.direction).toBe(LedgerDirection.Credit);
      expect(result.entry.balanceBefore.toString()).toBe('100.00');
      expect(result.entry.balanceAfter.toString()).toBe('125.00');
      expect(result.entry.walletVersion).toBe(2);
      expect(result.entry.isBalanced()).toBe(true);
    });

    test('movimentação de 0.00 é rejeitada', () => {
      const wallet = Wallet.open({ id: walletId, playerId, initialBalance: brl('100.00') });

      expect(() => wallet.debit({ transactionId, money: brl('0.00') })).toThrow(ZeroMovementError);
      expect(() => wallet.credit({ transactionId, money: brl('0.00') })).toThrow(ZeroMovementError);
      expect(wallet.balance.toString()).toBe('100.00');
      expect(wallet.version).toBe(1);
    });

    test('Money negativo em debit/credit é rejeitado', () => {
      const wallet = Wallet.open({ id: walletId, playerId, initialBalance: brl('100.00') });
      const negative = brl('25.00').negate();

      expect(() => wallet.debit({ transactionId, money: negative })).toThrow(InvalidWalletError);
      expect(() => wallet.credit({ transactionId, money: negative })).toThrow(InvalidWalletError);
    });

    test('conflito de moeda é rejeitado', () => {
      const wallet = Wallet.open({ id: walletId, playerId, initialBalance: brl('100.00') });

      expect(() =>
        wallet.debit({ transactionId, money: Money.from({ amount: '25.00', currency: 'USD' }) })
      ).toThrow(CurrencyMismatchError);
      expect(wallet.balance.toString()).toBe('100.00');
      expect(wallet.version).toBe(1);
    });

    test('versão incrementa estritamente a cada mudança de saldo', () => {
      const wallet = Wallet.open({ id: walletId, playerId, initialBalance: brl('100.00') });

      const debit = wallet.debit({ transactionId, money: brl('10.00') });
      const credit = wallet.credit({ transactionId, money: brl('5.00') });

      expect(debit.entry.walletVersion).toBe(2);
      expect(credit.entry.walletVersion).toBe(3);
      expect(wallet.version).toBe(3);
      expect(wallet.balance.toString()).toBe('95.00');
    });

    test('walletVersion é consecutivo por wallet', () => {
      const wallet = Wallet.open({ id: walletId, playerId, initialBalance: brl('0.00') });

      const first = wallet.credit({ transactionId, money: brl('10.00') });
      const second = wallet.debit({ transactionId, money: brl('5.00') });

      expect(first.entry.walletVersion).toBe(2);
      expect(second.entry.walletVersion).toBe(3);
    });

    test('saldo nunca fica negativo', () => {
      const wallet = Wallet.open({ id: walletId, playerId, initialBalance: brl('50.00') });

      wallet.debit({ transactionId, money: brl('50.00') });
      expect(wallet.balance.toString()).toBe('0.00');
      expect(() => wallet.debit({ transactionId, money: brl('0.01') })).toThrow(
        InsufficientBalanceError
      );
      expect(wallet.balance.isNegative()).toBe(false);
    });
  });

  describe('rehydrate', () => {
    test('reconstrói o estado persistido', () => {
      const updatedAt = new Date('2026-07-29T15:02:00.000Z');
      const wallet = Wallet.rehydrate({
        id: walletId,
        playerId,
        currency: 'BRL',
        balance: brl('75.00'),
        version: 4,
        createdAt,
        updatedAt
      });

      expect(wallet.balance.toString()).toBe('75.00');
      expect(wallet.version).toBe(4);
      expect(wallet.updatedAt).toBe(updatedAt);
    });

    test('rejeita versão inválida', () => {
      expect(() =>
        Wallet.rehydrate({
          id: walletId,
          playerId,
          currency: 'BRL',
          balance: brl('75.00'),
          version: 0,
          createdAt,
          updatedAt: createdAt
        })
      ).toThrow(InvalidWalletError);
    });
  });
});
