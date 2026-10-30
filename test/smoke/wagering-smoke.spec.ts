import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import request from 'supertest';
import { newUuidV7 } from '../../src/shared/id/uuid';
import { createTestApplication, TestApplication } from '../integration/support/app-harness';
import { ensurePostgres, PostgresHarness } from '../integration/support/postgres-harness';
import { FailureCode } from '../../src/shared/errors/failure-code';
import { LedgerDirection } from '../../src/domain/ledger/ledger-direction';
import { WagerTransactionKind } from '../../src/domain/wager-transaction/wager-transaction-kind';
import { WagerTransactionStatus } from '../../src/domain/wager-transaction/wager-transaction-status';

const PROVIDER = 'provider-smoke';
const CURRENCY = 'BRL';

interface Wallet {
  walletId: string;
  playerId: string;
}

interface TxOptions {
  kind: string;
  amount: string;
  reference?: string;
  idempotencyKey?: string;
  externalTransactionId?: string;
  wallet: Wallet;
}

describe('Smoke completo', () => {
  let postgres: PostgresHarness;
  let application: TestApplication;
  let sequence = 0;

  const server = () => application.app.getHttpServer();

  function nextId(prefix: string): string {
    sequence += 1;
    return `${prefix}-${Date.now()}-${sequence}`;
  }

  async function createWallet(initialBalance = '1000.00'): Promise<Wallet> {
    const playerId = newUuidV7();
    const response = await request(server())
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: initialBalance, currency: CURRENCY } });
    expect(response.status).toBe(201);
    return { walletId: response.body.id, playerId };
  }

  function body(options: TxOptions) {
    return {
      providerId: PROVIDER,
      externalTransactionId: options.externalTransactionId ?? nextId('smoke'),
      playerId: options.wallet.playerId,
      walletId: options.wallet.walletId,
      roundId: 'round-smoke',
      gameId: 'fortune-chimp',
      kind: options.kind,
      money: { amount: options.amount, currency: CURRENCY },
      ...(options.reference === undefined
        ? {}
        : { referenceExternalTransactionId: options.reference })
    };
  }

  async function post(options: TxOptions) {
    return request(server())
      .post('/wagering/transactions')
      .set('Idempotency-Key', options.idempotencyKey ?? newUuidV7())
      .send(body(options));
  }

  async function expectStatus(options: TxOptions, status: number) {
    const response = await post(options);
    expect(response.status).toBe(status);
    return response;
  }

  beforeAll(async () => {
    postgres = await ensurePostgres();
    application = await createTestApplication(postgres, 'smoke_e2e', {
      MESSAGING_ENABLED: '0',
      METRICS_DLQ_ENABLED: '0'
    });
  }, 240000);

  afterAll(async () => {
    await application?.close();
    await postgres?.stop();
  }, 240000);

  test('cadeia determinística: OPENING, BET, REFUND, WIN, ROLLBACK, LOSS e reconciliação', async () => {
    const wallet = await createWallet('1000.00');

    const walletView = await request(server()).get(`/wallets/${wallet.walletId}`);
    expect(walletView.body.balance).toEqual({ amount: '1000.00', currency: CURRENCY });
    expect(walletView.body.version).toBe(1);

    const ledger = await request(server()).get(`/wallets/${wallet.walletId}/ledger`);
    expect(ledger.body.items).toHaveLength(1);
    expect(ledger.body.items[0]).toMatchObject({
      direction: LedgerDirection.Credit,
      walletVersion: 1,
      balanceBefore: { amount: '0.00', currency: CURRENCY },
      balanceAfter: { amount: '1000.00', currency: CURRENCY }
    });
    const openingTransactionId = ledger.body.items[0].transactionId as string;

    const bet1External = nextId('bet1');
    const bet1Key = newUuidV7();
    const bet1 = await expectStatus(
      {
        wallet,
        kind: WagerTransactionKind.Bet,
        amount: '25.00',
        externalTransactionId: bet1External,
        idempotencyKey: bet1Key
      },
      201
    );
    expect(bet1.body).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: { amount: '975.00', currency: CURRENCY },
      idempotentReplay: false
    });

    const refund1 = await expectStatus(
      { wallet, kind: WagerTransactionKind.Refund, amount: '25.00', reference: bet1External },
      201
    );
    expect(refund1.body.balance).toEqual({ amount: '1000.00', currency: CURRENCY });

    const winOnRevertedBet = await expectStatus(
      {
        wallet,
        kind: WagerTransactionKind.Win,
        amount: '25.00',
        reference: bet1External
      },
      422
    );
    expect(winOnRevertedBet.body.failureCode).toBe(FailureCode.ReferenceAlreadyReverted);

    const refund2 = await expectStatus(
      { wallet, kind: WagerTransactionKind.Refund, amount: '25.00', reference: bet1External },
      422
    );
    expect(refund2.body.failureCode).toBe(FailureCode.ReferenceAlreadyReverted);

    const bet2External = nextId('bet2');
    await expectStatus(
      {
        wallet,
        kind: WagerTransactionKind.Bet,
        amount: '25.00',
        externalTransactionId: bet2External
      },
      201
    );

    const win1External = nextId('win1');
    const win1 = await expectStatus(
      {
        wallet,
        kind: WagerTransactionKind.Win,
        amount: '50.00',
        reference: bet2External,
        externalTransactionId: win1External
      },
      201
    );
    expect(win1.body.balance).toEqual({ amount: '1025.00', currency: CURRENCY });

    const win2 = await expectStatus(
      { wallet, kind: WagerTransactionKind.Win, amount: '50.00', reference: bet2External },
      422
    );
    expect(win2.body.failureCode).toBe(FailureCode.ReferenceAlreadySettled);

    const lossDuplicated = await expectStatus(
      { wallet, kind: WagerTransactionKind.Loss, amount: '25.00', reference: bet2External },
      422
    );
    expect(lossDuplicated.body.failureCode).toBe(FailureCode.ReferenceAlreadySettled);

    const refundActiveWin = await expectStatus(
      { wallet, kind: WagerTransactionKind.Refund, amount: '25.00', reference: bet2External },
      422
    );
    expect(refundActiveWin.body.failureCode).toBe(FailureCode.ReferenceHasProcessedWin);

    const rollbackWin = await expectStatus(
      {
        wallet,
        kind: WagerTransactionKind.Rollback,
        amount: '50.00',
        reference: win1External
      },
      201
    );
    expect(rollbackWin.body.balance).toEqual({ amount: '975.00', currency: CURRENCY });

    const bet3External = nextId('bet3');
    await expectStatus(
      {
        wallet,
        kind: WagerTransactionKind.Bet,
        amount: '10.00',
        externalTransactionId: bet3External
      },
      201
    );
    const loss = await expectStatus(
      { wallet, kind: WagerTransactionKind.Loss, amount: '10.00', reference: bet3External },
      201
    );
    expect(loss.body.balance).toEqual({ amount: '965.00', currency: CURRENCY });

    const bet4External = nextId('bet4');
    await expectStatus(
      {
        wallet,
        kind: WagerTransactionKind.Bet,
        amount: '20.00',
        externalTransactionId: bet4External
      },
      201
    );
    const rollbackBet = await expectStatus(
      { wallet, kind: WagerTransactionKind.Rollback, amount: '20.00', reference: bet4External },
      201
    );
    expect(rollbackBet.body.balance).toEqual({ amount: '965.00', currency: CURRENCY });

    const bet5External = nextId('bet5');
    const bet5 = await expectStatus(
      {
        wallet,
        kind: WagerTransactionKind.Bet,
        amount: '7.00',
        externalTransactionId: bet5External
      },
      201
    );
    expect(bet5.body.balance).toEqual({ amount: '958.00', currency: CURRENCY });

    const win5 = await expectStatus(
      {
        wallet,
        kind: WagerTransactionKind.Win,
        amount: '14.00',
        reference: bet5External,
        externalTransactionId: nextId('win5')
      },
      201
    );
    expect(win5.body.balance).toEqual({ amount: '972.00', currency: CURRENCY });

    const replay = await request(server())
      .post('/wagering/transactions')
      .set('Idempotency-Key', bet1Key)
      .send(
        body({
          wallet,
          kind: WagerTransactionKind.Bet,
          amount: '25.00',
          externalTransactionId: bet1External
        })
      );
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      transactionId: bet1.body.transactionId,
      status: WagerTransactionStatus.Processed,
      balance: { amount: '975.00', currency: CURRENCY },
      idempotentReplay: true
    });

    const replayConflict = await request(server())
      .post('/wagering/transactions')
      .set('Idempotency-Key', bet1Key)
      .send(
        body({
          wallet,
          kind: WagerTransactionKind.Bet,
          amount: '26.00',
          externalTransactionId: bet1External
        })
      );
    expect(replayConflict.status).toBe(409);
    expect(replayConflict.body.failureCode).toBe(FailureCode.IdempotencyPayloadMismatch);

    const opening = await request(server()).get(`/wagering/transactions/${openingTransactionId}`);
    expect(opening.status).toBe(200);
    expect(opening.body).toMatchObject({
      kind: WagerTransactionKind.Opening,
      status: WagerTransactionStatus.Processed,
      providerId: null,
      externalTransactionId: null
    });

    const reconciliation = await request(server()).post(
      `/wallets/${wallet.walletId}/reconciliation`
    );
    expect(reconciliation.status).toBe(200);
    expect(reconciliation.body).toEqual({
      walletId: wallet.walletId,
      storedBalance: { amount: '972.00', currency: CURRENCY },
      calculatedBalance: { amount: '972.00', currency: CURRENCY },
      difference: { amount: '0.00', currency: CURRENCY },
      consistent: true,
      checkedEntries: 11
    });

    const finalWallet = await request(server()).get(`/wallets/${wallet.walletId}`);
    expect(finalWallet.body.balance).toEqual({ amount: '972.00', currency: CURRENCY });
  }, 120000);

  test('cenário obrigatório 100/80/80: 1 PROCESSED, 1 REJECTED, saldo 20 e 1 lançamento', async () => {
    const wallet = await createWallet('100.00');

    const first = await expectStatus(
      { wallet, kind: WagerTransactionKind.Bet, amount: '80.00' },
      201
    );
    expect(first.body.balance).toEqual({ amount: '20.00', currency: CURRENCY });

    const second = await expectStatus(
      { wallet, kind: WagerTransactionKind.Bet, amount: '80.00' },
      422
    );
    expect(second.body).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InsufficientFunds
    });

    const finalWallet = await request(server()).get(`/wallets/${wallet.walletId}`);
    expect(finalWallet.body.balance).toEqual({ amount: '20.00', currency: CURRENCY });

    const ledger = await request(server()).get(`/wallets/${wallet.walletId}/ledger`);
    const debits = (ledger.body.items as { direction: string }[]).filter(
      (item) => item.direction === LedgerDirection.Debit
    );
    expect(debits).toHaveLength(1);

    const reconciliation = await request(server()).post(
      `/wallets/${wallet.walletId}/reconciliation`
    );
    expect(reconciliation.body.consistent).toBe(true);
    expect(reconciliation.body.storedBalance).toEqual({ amount: '20.00', currency: CURRENCY });
  }, 120000);

  test('health e métricas fecham a entrega', async () => {
    const live = await request(server()).get('/health/live');
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ status: 'OK' });

    const metrics = await request(server()).get('/metrics');
    expect(metrics.status).toBe(200);
    expect(metrics.text).toMatch(/wager_transactions_total\{[^}]*status="PROCESSED"[^}]*\} /);
  });
});
