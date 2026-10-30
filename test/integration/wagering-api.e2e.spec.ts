import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import request from 'supertest';
import { newUuidV7 } from '../../src/shared/id/uuid';
import { ensurePostgres, PostgresHarness } from './support/postgres-harness';
import { createTestApplication, TestApplication } from './support/app-harness';
import { WagerTransactionStatus } from '../../src/domain/wager-transaction/wager-transaction-status';
import { FailureCode } from '../../src/shared/errors/failure-code';
import { LedgerDirection } from '../../src/domain/ledger/ledger-direction';
import { WagerTransactionKind } from '../../src/domain/wager-transaction/wager-transaction-kind';
import { insertTransaction } from './support/sql-fixtures';

const PROVIDER = 'provider-e2e';
const CURRENCY = 'BRL';

interface WalletFixture {
  walletId: string;
  playerId: string;
}

interface TransactionFixture {
  walletId: string;
  playerId: string;
  kind: string;
  amount: string;
  externalTransactionId?: string;
  referenceExternalTransactionId?: string;
  idempotencyKey?: string;
  currency?: string;
  providerId?: string;
  playerOverride?: string;
}

describe('Wagering API (e2e)', () => {
  let harness: PostgresHarness;
  let application: TestApplication;
  let sequence = 0;

  const server = () => application.app.getHttpServer();

  function nextExternalId(prefix = 'tx'): string {
    sequence += 1;
    return `${prefix}-${Date.now()}-${sequence}`;
  }

  async function createWallet(
    initialBalance = '100.00',
    currency = CURRENCY
  ): Promise<WalletFixture> {
    const playerId = newUuidV7();
    const response = await request(server())
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: initialBalance, currency } });
    expect(response.status).toBe(201);
    return { walletId: response.body.id, playerId };
  }

  function transactionBody(fixture: TransactionFixture) {
    return {
      providerId: fixture.providerId ?? PROVIDER,
      externalTransactionId: fixture.externalTransactionId ?? nextExternalId(),
      playerId: fixture.playerOverride ?? fixture.playerId,
      walletId: fixture.walletId,
      roundId: 'round-e2e',
      gameId: 'fortune-chimp',
      kind: fixture.kind,
      money: { amount: fixture.amount, currency: fixture.currency ?? CURRENCY },
      ...(fixture.referenceExternalTransactionId === undefined
        ? {}
        : { referenceExternalTransactionId: fixture.referenceExternalTransactionId })
    };
  }

  function postTransaction(fixture: TransactionFixture, idempotencyKey?: string) {
    return request(server())
      .post('/wagering/transactions')
      .set('Idempotency-Key', idempotencyKey ?? newUuidV7())
      .send(transactionBody(fixture));
  }

  beforeAll(async () => {
    harness = await ensurePostgres();
    application = await createTestApplication(harness, 'api_e2e');
  }, 180000);

  afterAll(async () => {
    await application?.close();
    await harness?.stop();
  }, 180000);

  test('cria wallet com OPENING, lançamento walletVersion 1 e reconciliação consistente', async () => {
    const wallet = await createWallet('100.00');

    const view = await request(server()).get(`/wallets/${wallet.walletId}`);
    expect(view.status).toBe(200);
    expect(view.body).toEqual({
      id: wallet.walletId,
      playerId: wallet.playerId,
      balance: { amount: '100.00', currency: CURRENCY },
      version: 1
    });

    const ledger = await request(server()).get(`/wallets/${wallet.walletId}/ledger`);
    expect(ledger.status).toBe(200);
    expect(ledger.body.items).toHaveLength(1);
    expect(ledger.body.items[0]).toMatchObject({
      direction: LedgerDirection.Credit,
      money: { amount: '100.00', currency: CURRENCY },
      balanceBefore: { amount: '0.00', currency: CURRENCY },
      balanceAfter: { amount: '100.00', currency: CURRENCY },
      walletVersion: 1
    });

    const opening = await request(server()).get(
      `/wagering/transactions/${ledger.body.items[0].transactionId}`
    );
    expect(opening.status).toBe(200);
    expect(opening.body).toMatchObject({
      kind: WagerTransactionKind.Opening,
      providerId: null,
      externalTransactionId: null,
      status: WagerTransactionStatus.Processed
    });

    const reconciliation = await request(server()).post(
      `/wallets/${wallet.walletId}/reconciliation`
    );
    expect(reconciliation.status).toBe(200);
    expect(reconciliation.body).toMatchObject({
      walletId: wallet.walletId,
      storedBalance: { amount: '100.00', currency: CURRENCY },
      calculatedBalance: { amount: '100.00', currency: CURRENCY },
      difference: { amount: '0.00', currency: CURRENCY },
      consistent: true,
      checkedEntries: 1
    });

    const events = await application.database.orm.em
      .fork()
      .execute<{ event_type: string }[]>(
        'select event_type from outbox_messages order by event_type'
      );
    expect(events.map((event) => event.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged'
    ]);
  });

  test('wallet com saldo inicial 0.00 não cria OPENING e o primeiro lançamento usa walletVersion 2', async () => {
    const wallet = await createWallet('0.00');

    const emptyLedger = await request(server()).get(`/wallets/${wallet.walletId}/ledger`);
    expect(emptyLedger.body.items).toHaveLength(0);
    expect(emptyLedger.body.nextCursor).toBeNull();

    const emptyReconciliation = await request(server()).post(
      `/wallets/${wallet.walletId}/reconciliation`
    );
    expect(emptyReconciliation.body).toMatchObject({
      consistent: true,
      checkedEntries: 0
    });

    await insertTransaction(application.database.orm.em.fork(), {
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      providerId: PROVIDER,
      externalTransactionId: 'zero-balance-bet',
      roundId: 'round-e2e',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      status: WagerTransactionStatus.Processed,
      amount: '5.00',
      balanceAfterAmount: '0.00'
    });

    const win = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Win,
      amount: '5.00',
      referenceExternalTransactionId: 'zero-balance-bet'
    });
    expect(win.status).toBe(201);
    expect(win.body.status).toBe(WagerTransactionStatus.Processed);
    expect(win.body.balance).toEqual({ amount: '5.00', currency: CURRENCY });

    const ledger = await request(server()).get(`/wallets/${wallet.walletId}/ledger`);
    expect(ledger.body.items[0].walletVersion).toBe(2);
    expect(ledger.body.items[0].balanceBefore).toEqual({ amount: '0.00', currency: CURRENCY });

    const reconciliation = await request(server()).post(
      `/wallets/${wallet.walletId}/reconciliation`
    );
    expect(reconciliation.body).toMatchObject({ consistent: true, checkedEntries: 1 });
  });

  test('wallet duplicada retorna 409 e initialBalance ausente retorna 400', async () => {
    const wallet = await createWallet('10.00');

    const duplicate = await request(server())
      .post('/wallets')
      .send({
        playerId: wallet.playerId,
        initialBalance: { amount: '10.00', currency: CURRENCY }
      });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.failureCode).toBe(FailureCode.WalletAlreadyExists);

    const missing = await request(server()).post('/wallets').send({ playerId: newUuidV7() });
    expect(missing.status).toBe(400);
    expect(missing.body.failureCode).toBe(FailureCode.InvalidPayload);
  });

  test('BET processada, replay idempotente, conflito de payload e duplicata de external id', async () => {
    const wallet = await createWallet('100.00');
    const externalTransactionId = nextExternalId('bet');
    const idempotencyKey = newUuidV7();
    const fixture: TransactionFixture = {
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Bet,
      amount: '25.00',
      externalTransactionId
    };

    const first = await postTransaction(fixture, idempotencyKey);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: { amount: '75.00', currency: CURRENCY },
      idempotentReplay: false
    });

    const replay = await postTransaction(fixture, idempotencyKey);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      transactionId: first.body.transactionId,
      status: WagerTransactionStatus.Processed,
      balance: { amount: '75.00', currency: CURRENCY },
      idempotentReplay: true
    });

    const mismatch = await postTransaction({ ...fixture, amount: '30.00' }, idempotencyKey);
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.failureCode).toBe(FailureCode.IdempotencyPayloadMismatch);

    const duplicateExternal = await postTransaction(fixture);
    expect(duplicateExternal.status).toBe(409);
    expect(duplicateExternal.body.failureCode).toBe(FailureCode.DuplicateExternalTransaction);

    const otherProvider = await postTransaction(
      {
        ...fixture,
        providerId: 'provider-e2e-b',
        externalTransactionId: nextExternalId('bet-b'),
        amount: '1.00'
      },
      idempotencyKey
    );
    expect(otherProvider.status).toBe(201);
    expect(otherProvider.body.transactionId).not.toBe(first.body.transactionId);
    expect(otherProvider.body.balance).toEqual({ amount: '74.00', currency: CURRENCY });

    const view = await request(server()).get(`/wallets/${wallet.walletId}`);
    expect(view.body.balance).toEqual({ amount: '74.00', currency: CURRENCY });
  });

  test('BET sem saldo é persistida como REJECTED e o replay devolve o mesmo failureCode', async () => {
    const wallet = await createWallet('100.00');
    const fixture: TransactionFixture = {
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Bet,
      amount: '150.00',
      externalTransactionId: nextExternalId('bet-rejected')
    };
    const idempotencyKey = newUuidV7();

    const rejected = await postTransaction(fixture, idempotencyKey);
    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({
      failureCode: FailureCode.InsufficientFunds,
      status: WagerTransactionStatus.Rejected,
      idempotentReplay: false
    });
    expect(typeof rejected.body.transactionId).toBe('string');

    const replay = await postTransaction(fixture, idempotencyKey);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({
      transactionId: rejected.body.transactionId,
      failureCode: FailureCode.InsufficientFunds,
      status: WagerTransactionStatus.Rejected,
      idempotentReplay: true
    });

    const stored = await request(server()).get(
      `/wagering/transactions/${rejected.body.transactionId}`
    );
    expect(stored.status).toBe(200);
    expect(stored.body).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InsufficientFunds
    });
    expect(typeof stored.body.resolvedAt).toBe('string');

    const reconciliation = await request(server()).post(
      `/wallets/${wallet.walletId}/reconciliation`
    );
    expect(reconciliation.body).toMatchObject({ consistent: true, checkedEntries: 1 });
  });

  test('WIN com referência válida credita, WIN sem referência é rejeitado e referência ausente fica PENDING_REFERENCE', async () => {
    const wallet = await createWallet('100.00');
    const bet = nextExternalId('bet');

    const betResponse = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Bet,
      amount: '20.00',
      externalTransactionId: bet
    });
    expect(betResponse.status).toBe(201);

    const win = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Win,
      amount: '40.00',
      referenceExternalTransactionId: bet
    });
    expect(win.status).toBe(201);
    expect(win.body).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: { amount: '120.00', currency: CURRENCY }
    });

    const uncorrelated = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Win,
      amount: '10.00'
    });
    expect(uncorrelated.status).toBe(422);
    expect(uncorrelated.body).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceRequired
    });
    const afterRejected = await request(server()).get(`/wallets/${wallet.walletId}`);
    expect(afterRejected.body.balance.amount).toBe('120.00');

    const settled = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Win,
      amount: '40.00',
      referenceExternalTransactionId: bet
    });
    expect(settled.status).toBe(422);
    expect(settled.body.failureCode).toBe(FailureCode.ReferenceAlreadySettled);

    const pending = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Win,
      amount: '15.00',
      referenceExternalTransactionId: nextExternalId('missing')
    });
    expect(pending.status).toBe(202);
    expect(pending.body).toMatchObject({
      status: WagerTransactionStatus.PendingReference,
      idempotentReplay: false
    });
    expect(pending.body.balance).toBeUndefined();

    const storedPending = await request(server()).get(
      `/wagering/transactions/${pending.body.transactionId}`
    );
    expect(storedPending.body).toMatchObject({
      status: WagerTransactionStatus.PendingReference,
      resolvedAt: null
    });
  });

  test('reversões: WIN ativo bloqueia REFUND da BET, ROLLBACK do WIN libera e dupla reversão é rejeitada', async () => {
    const wallet = await createWallet('200.00');
    const bet = nextExternalId('bet');
    const win = nextExternalId('win');

    await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Bet,
      amount: '50.00',
      externalTransactionId: bet
    });
    const winResponse = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Win,
      amount: '100.00',
      externalTransactionId: win,
      referenceExternalTransactionId: bet
    });
    expect(winResponse.status).toBe(201);

    const blocked = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Refund,
      amount: '50.00',
      referenceExternalTransactionId: bet
    });
    expect(blocked.status).toBe(422);
    expect(blocked.body.failureCode).toBe(FailureCode.ReferenceHasProcessedWin);

    const rollback = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Rollback,
      amount: '100.00',
      referenceExternalTransactionId: win
    });
    expect(rollback.status).toBe(201);
    expect(rollback.body).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: { amount: '150.00', currency: CURRENCY }
    });

    const refund = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Refund,
      amount: '50.00',
      referenceExternalTransactionId: bet
    });
    expect(refund.status).toBe(201);
    expect(refund.body).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: { amount: '200.00', currency: CURRENCY }
    });

    const secondReversal = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Refund,
      amount: '50.00',
      referenceExternalTransactionId: bet
    });
    expect(secondReversal.status).toBe(422);
    expect(secondReversal.body.failureCode).toBe(FailureCode.ReferenceAlreadyReverted);
  });

  test('7.4: reversão única por alvo vale entre REFUND e ROLLBACK', async () => {
    const wallet = await createWallet('200.00');
    const bet = nextExternalId('bet');

    const betResponse = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Bet,
      amount: '50.00',
      externalTransactionId: bet
    });
    expect(betResponse.status).toBe(201);

    const refundExternal = nextExternalId('refund');
    const refund = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Refund,
      amount: '50.00',
      externalTransactionId: refundExternal,
      referenceExternalTransactionId: bet
    });
    expect(refund.status).toBe(201);

    const rollbackSameBet = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Rollback,
      amount: '50.00',
      referenceExternalTransactionId: bet
    });
    expect(rollbackSameBet.status).toBe(422);
    expect(rollbackSameBet.body.failureCode).toBe(FailureCode.ReferenceAlreadyReverted);

    const rollbackRefund = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Rollback,
      amount: '50.00',
      referenceExternalTransactionId: refundExternal
    });
    expect(rollbackRefund.status).toBe(201);
    expect(rollbackRefund.body).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: { amount: '150.00', currency: CURRENCY }
    });

    const refundAfterRollback = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Refund,
      amount: '50.00',
      referenceExternalTransactionId: bet
    });
    expect(refundAfterRollback.status).toBe(422);
    expect(refundAfterRollback.body.failureCode).toBe(FailureCode.ReferenceAlreadyReverted);
  });

  test('LOSS referencia a BET, permite void posterior e consome o slot de settlement', async () => {
    const wallet = await createWallet('200.00');
    const bet = nextExternalId('bet');

    await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Bet,
      amount: '30.00',
      externalTransactionId: bet
    });

    const loss = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Loss,
      amount: '30.00',
      referenceExternalTransactionId: bet
    });
    expect(loss.status).toBe(201);
    expect(loss.body).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: { amount: '170.00', currency: CURRENCY }
    });

    const refund = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Refund,
      amount: '30.00',
      referenceExternalTransactionId: bet
    });
    expect(refund.status).toBe(201);
    expect(refund.body).toMatchObject({
      status: WagerTransactionStatus.Processed,
      balance: { amount: '200.00', currency: CURRENCY }
    });

    const win = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Win,
      amount: '30.00',
      referenceExternalTransactionId: bet
    });
    expect(win.status).toBe(422);
    expect(win.body.failureCode).toBe(FailureCode.ReferenceAlreadySettled);

    const unlinkedLoss = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Loss,
      amount: '5.00'
    });
    expect(unlinkedLoss.status).toBe(201);
    expect(unlinkedLoss.body.status).toBe(WagerTransactionStatus.Processed);
  });

  test('validações estruturais e idempotency key', async () => {
    const wallet = await createWallet('50.00');
    const external = nextExternalId('bet');

    const betWithReference = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Bet,
      amount: '1.00',
      referenceExternalTransactionId: nextExternalId('ref')
    });
    expect(betWithReference.status).toBe(400);
    expect(betWithReference.body.failureCode).toBe(FailureCode.InvalidPayload);

    const refundWithoutReference = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Refund,
      amount: '1.00'
    });
    expect(refundWithoutReference.status).toBe(400);

    const opening = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Opening,
      amount: '1.00'
    });
    expect(opening.status).toBe(400);
    expect(opening.body.failureCode).toBe(FailureCode.OpeningNotAllowed);

    const selfReference = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Refund,
      amount: '1.00',
      externalTransactionId: external,
      referenceExternalTransactionId: external
    });
    expect(selfReference.status).toBe(400);

    const missingKey = await request(server())
      .post('/wagering/transactions')
      .send(
        transactionBody({
          walletId: wallet.walletId,
          playerId: wallet.playerId,
          kind: WagerTransactionKind.Bet,
          amount: '1.00'
        })
      );
    expect(missingKey.status).toBe(400);

    const longKey = await request(server())
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'k'.repeat(255))
      .send(
        transactionBody({
          walletId: wallet.walletId,
          playerId: wallet.playerId,
          kind: WagerTransactionKind.Bet,
          amount: '1.00'
        })
      );
    expect(longKey.status).toBe(201);

    const invalidUuid = await request(server()).get('/wallets/not-a-uuid');
    expect(invalidUuid.status).toBe(400);
    expect(invalidUuid.body.failureCode).toBe(FailureCode.InvalidPayload);

    const longCorrelationId = await request(server())
      .get('/health/live')
      .set('X-Correlation-Id', 'c'.repeat(256));
    expect(longCorrelationId.status).toBe(400);

    const emptyCursor = await request(server())
      .get(`/wallets/${wallet.walletId}/ledger`)
      .query({ cursor: '' });
    expect(emptyCursor.status).toBe(400);
  });

  test('ownership, moeda, wallet inexistente e recursos ausentes', async () => {
    const wallet = await createWallet('100.00');

    const mismatch = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      playerOverride: newUuidV7(),
      kind: WagerTransactionKind.Bet,
      amount: '1.00'
    });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.failureCode).toBe(FailureCode.WalletPlayerMismatch);

    const currencyMismatch = await postTransaction({
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Bet,
      amount: '1.00',
      currency: 'USD'
    });
    expect(currencyMismatch.status).toBe(422);
    expect(currencyMismatch.body.failureCode).toBe(FailureCode.CurrencyMismatch);

    const missingWallet = await postTransaction({
      walletId: newUuidV7(),
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Bet,
      amount: '1.00'
    });
    expect(missingWallet.status).toBe(422);
    expect(missingWallet.body.failureCode).toBe(FailureCode.WalletNotFound);

    const missingWalletGet = await request(server()).get(`/wallets/${newUuidV7()}`);
    expect(missingWalletGet.status).toBe(404);

    const missingReconciliation = await request(server()).post(
      `/wallets/${newUuidV7()}/reconciliation`
    );
    expect(missingReconciliation.status).toBe(404);
  });

  test('paginação do ledger por walletVersion e validação de cursor/limit', async () => {
    const wallet = await createWallet('100.00');
    for (const [betAmount, winAmount] of [
      ['1.00', '2.00'],
      ['2.00', '3.00']
    ] as const) {
      const betExternalId = nextExternalId('pagination-bet');
      const bet = await postTransaction({
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Bet,
        amount: betAmount,
        externalTransactionId: betExternalId
      });
      expect(bet.status).toBe(201);

      const win = await postTransaction({
        walletId: wallet.walletId,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Win,
        amount: winAmount,
        referenceExternalTransactionId: betExternalId
      });
      expect(win.status).toBe(201);
    }

    const first = await request(server())
      .get(`/wallets/${wallet.walletId}/ledger`)
      .query({ limit: '2' });
    expect(first.status).toBe(200);
    expect(first.body.items.map((item: { walletVersion: number }) => item.walletVersion)).toEqual([
      5, 4
    ]);
    expect(typeof first.body.nextCursor).toBe('string');

    const second = await request(server())
      .get(`/wallets/${wallet.walletId}/ledger`)
      .query({ limit: '2', cursor: first.body.nextCursor });
    expect(second.body.items.map((item: { walletVersion: number }) => item.walletVersion)).toEqual([
      3, 2
    ]);
    expect(typeof second.body.nextCursor).toBe('string');

    const third = await request(server())
      .get(`/wallets/${wallet.walletId}/ledger`)
      .query({ limit: '2', cursor: second.body.nextCursor });
    expect(third.body.items.map((item: { walletVersion: number }) => item.walletVersion)).toEqual([
      1
    ]);
    expect(third.body.nextCursor).toBeNull();

    const invalidCursor = await request(server())
      .get(`/wallets/${wallet.walletId}/ledger`)
      .query({ cursor: 'not-base64!' });
    expect(invalidCursor.status).toBe(400);

    const invalidLimit = await request(server())
      .get(`/wallets/${wallet.walletId}/ledger`)
      .query({ limit: '201' });
    expect(invalidLimit.status).toBe(400);

    const nonNumericLimit = await request(server())
      .get(`/wallets/${wallet.walletId}/ledger`)
      .query({ limit: 'abc' });
    expect(nonNumericLimit.status).toBe(400);
  });

  test('reconciliação detecta divergência injetada fora do ledger', async () => {
    const wallet = await createWallet('100.00');

    await application.database.orm.em.fork().transactional(async (tx) => {
      await tx.execute("set local session_replication_role = 'replica'");
      await tx.execute('update wallets set balance_amount = 110.00 where id = ?', [
        wallet.walletId
      ]);
    });

    const reconciliation = await request(server()).post(
      `/wallets/${wallet.walletId}/reconciliation`
    );
    expect(reconciliation.status).toBe(200);
    expect(reconciliation.body).toMatchObject({
      storedBalance: { amount: '110.00', currency: CURRENCY },
      calculatedBalance: { amount: '100.00', currency: CURRENCY },
      difference: { amount: '-10.00', currency: CURRENCY },
      consistent: false,
      checkedEntries: 1
    });
  });

  test('consulta de transação por provider/external e correlação persistida/ecoada', async () => {
    const wallet = await createWallet('100.00');
    const externalTransactionId = nextExternalId('bet');
    const correlationId = `corr-${newUuidV7()}`;

    const created = await request(server())
      .post('/wagering/transactions')
      .set('Idempotency-Key', newUuidV7())
      .set('X-Correlation-Id', correlationId)
      .send(
        transactionBody({
          walletId: wallet.walletId,
          playerId: wallet.playerId,
          kind: WagerTransactionKind.Bet,
          amount: '25.00',
          externalTransactionId
        })
      );
    expect(created.status).toBe(201);
    expect(created.headers['x-correlation-id']).toBe(correlationId);

    const byExternal = await request(server()).get(
      `/providers/${PROVIDER}/wagering/transactions/${externalTransactionId}`
    );
    expect(byExternal.status).toBe(200);
    expect(byExternal.body.transactionId).toBe(created.body.transactionId);

    const rows = await application.database.orm.em
      .fork()
      .execute<{ correlation_id: string }[]>(
        'select correlation_id from wager_transactions where id = ?',
        [created.body.transactionId]
      );
    expect(rows[0]?.correlation_id).toBe(correlationId);

    const generated = await request(server()).get('/health/live');
    expect(generated.headers['x-correlation-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );

    const missing = await request(server()).get(
      `/providers/${PROVIDER}/wagering/transactions/${nextExternalId('missing')}`
    );
    expect(missing.status).toBe(404);
    expect(missing.body.failureCode).toBe(FailureCode.TransactionNotFound);
  });
});
