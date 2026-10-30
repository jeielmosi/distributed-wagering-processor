import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from './money.errors';
import { Money } from './money';

describe('Money', () => {
  describe('criação', () => {
    test('aceita valores válidos e normaliza para duas casas', () => {
      expect(Money.from({ amount: '25.00', currency: 'BRL' }).toString()).toBe('25.00');
      expect(Money.from({ amount: '25', currency: 'BRL' }).toString()).toBe('25.00');
      expect(Money.from({ amount: '0.1', currency: 'BRL' }).toString()).toBe('0.10');
      expect(Money.from({ amount: '0.00', currency: 'BRL' }).toString()).toBe('0.00');
    });

    test('normaliza a moeda com trim e uppercase', () => {
      expect(Money.from({ amount: '10.00', currency: ' brl ' }).currency).toBe('BRL');
    });

    test('rejeita valor negativo em Money.from', () => {
      expect(() => Money.from({ amount: '-25.00', currency: 'BRL' })).toThrow(InvalidMoneyError);
    });

    test('rejeita NaN, Infinity e notação científica', () => {
      expect(() => Money.from({ amount: 'NaN', currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: 'Infinity', currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '1e3', currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '-Infinity', currency: 'BRL' })).toThrow(InvalidMoneyError);
    });

    test('rejeita string vazia e formatos não decimais', () => {
      expect(() => Money.from({ amount: '', currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: ' 25.00', currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '+25.00', currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '.50', currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '25.', currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: 'abc', currency: 'BRL' })).toThrow(InvalidMoneyError);
    });

    test('arredondamento: rejeitado', () => {
      expect(() => Money.from({ amount: '10.001', currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '0.005', currency: 'BRL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '25.999', currency: 'BRL' })).toThrow(InvalidMoneyError);
    });

    test('rejeita overflow do NUMERIC(18,2)', () => {
      expect(() => Money.from({ amount: '10000000000000000.00', currency: 'BRL' })).toThrow(
        InvalidMoneyError
      );
      expect(Money.from({ amount: '9999999999999999.99', currency: 'BRL' }).toString()).toBe(
        '9999999999999999.99'
      );
    });

    test('rejeita overflow em add, subtract e negate', () => {
      const max = Money.from({ amount: '9999999999999999.99', currency: 'BRL' });
      const cent = Money.from({ amount: '0.01', currency: 'BRL' });

      expect(() => max.add(cent)).toThrow(InvalidMoneyError);

      const negativeMax = Money.zero('BRL').subtract(max);
      expect(negativeMax.toString()).toBe('-9999999999999999.99');
      expect(() => negativeMax.subtract(max)).toThrow(InvalidMoneyError);
      expect(negativeMax.negate().equals(max)).toBe(true);
    });

    test('rejeita moeda fora da allowlist ISO-4217', () => {
      expect(() => Money.from({ amount: '10.00', currency: 'AAA' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '10.00', currency: 'ZZZ' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '10.00', currency: 'XX' })).toThrow(InvalidMoneyError);
    });
  });

  describe('zero', () => {
    test('Money.zero cria zero na moeda informada', () => {
      const zero = Money.zero('BRL');
      expect(zero.toString()).toBe('0.00');
      expect(zero.isZero()).toBe(true);
      expect(zero.isPositive()).toBe(false);
      expect(zero.isNegative()).toBe(false);
    });
  });

  describe('aritmética', () => {
    test('soma com exatidão decimal', () => {
      const result = Money.from({ amount: '0.10', currency: 'BRL' }).add(
        Money.from({ amount: '0.20', currency: 'BRL' })
      );
      expect(result.toString()).toBe('0.30');
    });

    test('subtração retorna resultado assinado quando negativo', () => {
      const result = Money.from({ amount: '10.00', currency: 'BRL' }).subtract(
        Money.from({ amount: '25.00', currency: 'BRL' })
      );
      expect(result.toString()).toBe('-15.00');
      expect(result.isNegative()).toBe(true);
      expect(result.isPositive()).toBe(false);
    });

    test('negate inverte o sinal', () => {
      const positive = Money.from({ amount: '25.00', currency: 'BRL' });
      expect(positive.negate().toString()).toBe('-25.00');
      expect(positive.negate().negate().equals(positive)).toBe(true);
      expect(positive.negate().isNegative()).toBe(true);
    });

    test('operações entre moedas diferentes são rejeitadas', () => {
      const brl = Money.from({ amount: '10.00', currency: 'BRL' });
      const usd = Money.from({ amount: '10.00', currency: 'USD' });
      expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
    });

    test('compara valores', () => {
      const ten = Money.from({ amount: '10.00', currency: 'BRL' });
      const tenCopy = Money.from({ amount: '10', currency: 'BRL' });
      const twenty = Money.from({ amount: '20.00', currency: 'BRL' });
      expect(ten.equals(tenCopy)).toBe(true);
      expect(ten.equals(twenty)).toBe(false);
      expect(ten.isLessThan(twenty)).toBe(true);
      expect(twenty.isLessThan(ten)).toBe(false);
    });
  });

  describe('serialização', () => {
    test('toJSON retorna amount string com duas casas e currency', () => {
      expect(Money.from({ amount: '25', currency: 'brl' }).toJSON()).toEqual({
        amount: '25.00',
        currency: 'BRL'
      });
    });

    test('toString sempre usa duas casas', () => {
      expect(Money.from({ amount: '25', currency: 'BRL' }).toString()).toBe('25.00');
      expect(Money.from({ amount: '1.5', currency: 'BRL' }).toString()).toBe('1.50');
    });

    test('serializa valor negativo produzido por subtract', () => {
      const difference = Money.from({ amount: '5.00', currency: 'BRL' }).subtract(
        Money.from({ amount: '10.00', currency: 'BRL' })
      );
      expect(difference.toJSON()).toEqual({ amount: '-5.00', currency: 'BRL' });
    });
  });

  describe('imutabilidade', () => {
    test('operações retornam nova instância e preservam a original', () => {
      const original = Money.from({ amount: '10.00', currency: 'BRL' });
      const sum = original.add(Money.from({ amount: '5.00', currency: 'BRL' }));
      const difference = original.subtract(Money.from({ amount: '3.00', currency: 'BRL' }));
      const negated = original.negate();

      expect(sum).not.toBe(original);
      expect(difference).not.toBe(original);
      expect(negated).not.toBe(original);
      expect(original.toString()).toBe('10.00');
    });
  });
});
