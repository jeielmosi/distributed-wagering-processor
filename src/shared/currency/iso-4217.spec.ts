import { describe, expect, test } from 'bun:test';
import { isSupportedCurrency, normalizeCurrency } from './iso-4217';

describe('ISO-4217 allowlist', () => {
  test('normaliza moeda com trim e uppercase', () => {
    expect(normalizeCurrency(' brl ')).toBe('BRL');
    expect(normalizeCurrency('usd')).toBe('USD');
  });

  test('aceita moedas ativas', () => {
    expect(isSupportedCurrency('BRL')).toBe(true);
    expect(isSupportedCurrency('USD')).toBe(true);
    expect(isSupportedCurrency('EUR')).toBe(true);
    expect(isSupportedCurrency('JPY')).toBe(true);
  });

  test('rejeita códigos inexistentes ou desativados', () => {
    expect(isSupportedCurrency('AAA')).toBe(false);
    expect(isSupportedCurrency('ZZZ')).toBe(false);
    expect(isSupportedCurrency('XXX')).toBe(false);
    expect(isSupportedCurrency('XTS')).toBe(false);
    expect(isSupportedCurrency('')).toBe(false);
  });

  test('rejeita formato fora de três letras', () => {
    expect(isSupportedCurrency('BR')).toBe(false);
    expect(isSupportedCurrency('BRLL')).toBe(false);
    expect(isSupportedCurrency('B1L')).toBe(false);
  });
});
