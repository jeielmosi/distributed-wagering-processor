import { describe, expect, test } from 'bun:test';
import { newUuidV7 } from './uuid';

describe('newUuidV7', () => {
  test('gera UUID na versão 7', () => {
    const id = newUuidV7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('gera identificadores distintos', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newUuidV7()));
    expect(ids.size).toBe(1000);
  });

  test('é monotônico em ordem lexicográfica dentro do mesmo milissegundo', () => {
    const ids = Array.from({ length: 100 }, () => newUuidV7());
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });
});
