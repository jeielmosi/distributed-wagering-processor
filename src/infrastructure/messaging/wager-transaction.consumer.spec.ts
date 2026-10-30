import { describe, expect, test } from 'bun:test';
import { TransientFailureError } from '../../application/errors/application.errors';
import { InvalidMoneyError } from '../../domain/money/money.errors';
import type { InboxRepository } from '../../application/ports/inbox.repository';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { MessageQueuePort, QueueMessage } from '../../application/ports/message-queue.port';
import type { TransactionContext, UnitOfWork } from '../../application/ports/transaction-context';
import type { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case';
import { newUuidV7 } from '../../shared/id/uuid';
import type { MessagingSettings } from './messaging.config';
import { WagerTransactionConsumer } from './wager-transaction.consumer';
import { WagerTransactionStatus } from '../../domain/wager-transaction/wager-transaction-status';

const QUEUE_URL = 'https://sqs.local/wager';
const DLQ_URL = 'https://sqs.local/wager-dlq';

function settings(maxReceiveCount: number): MessagingSettings {
  return {
    enabled: false,
    consumerName: 'wager-transactions',
    wagerQueueUrl: QUEUE_URL,
    wagerDlqUrl: DLQ_URL,
    eventsQueueUrl: 'https://sqs.local/events',
    eventsDlqUrl: 'https://sqs.local/events-dlq',
    visibilityTimeoutSeconds: 60,
    maxNumberOfMessages: 1,
    pollIntervalMs: 1000,
    drainTimeoutMs: 1000,
    outboxLeaseMs: 30000,
    outboxBatchSize: 10,
    outboxPublishConcurrency: 4,
    pendingLeaseMs: 30000,
    pendingBatchSize: 10,
    faultAfterCommitBeforeAck: false,
    faultAfterPublishBeforeMark: false,
    consumerMaxReceiveCount: maxReceiveCount
  };
}

function message(receiveCount: number): QueueMessage {
  return {
    body: JSON.stringify({
      messageId: `msg-${newUuidV7()}`,
      type: 'WagerTransactionRequested',
      data: {
        providerId: 'provider',
        externalTransactionId: `ext-${newUuidV7()}`,
        idempotencyKey: `key-${newUuidV7()}`,
        playerId: newUuidV7(),
        walletId: newUuidV7(),
        roundId: 'round',
        gameId: 'game',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' }
      }
    }),
    messageId: `sqs-${newUuidV7()}`,
    receiptHandle: 'receipt-1',
    receiveCount
  };
}

function consumer(
  maxReceiveCount: number,
  incoming: QueueMessage,
  failure: unknown = new TransientFailureError()
): {
  consumer: WagerTransactionConsumer;
  published: string[];
  deleted: string[];
  visibility: number[];
} {
  const published: string[] = [];
  const deleted: string[] = [];
  const visibility: number[] = [];

  const queue: MessageQueuePort = {
    receive: async () => [incoming],
    delete: async (_url, receiptHandle) => {
      deleted.push(receiptHandle);
    },
    publish: async (url) => {
      published.push(url);
    },
    changeVisibility: async (_url, _receiptHandle, timeoutSeconds) => {
      visibility.push(timeoutSeconds);
    },
    getQueueAttributes: async () => ({ approximateNumberOfMessages: 0, oldestMessageAgeSeconds: 0 })
  };

  const unitOfWork: UnitOfWork = {
    run: async (work) => work({} as TransactionContext),
    current: () => ({}) as TransactionContext
  };

  const inbox: InboxRepository = {
    findByConsumerAndMessageId: async () => undefined,
    insertIfAbsent: async () => ({ inserted: true })
  };

  const useCase = {
    execute: async () => {
      throw failure;
    }
  } as unknown as ProcessWagerTransactionUseCase;

  return {
    consumer: new WagerTransactionConsumer(
      settings(maxReceiveCount),
      queue,
      unitOfWork,
      { now: async () => new Date() },
      inbox,
      useCase
    ),
    published,
    deleted,
    visibility
  };
}

function consumerWithDeleteFailure(incoming: QueueMessage): {
  consumer: WagerTransactionConsumer;
  published: string[];
  deleted: string[];
  visibility: number[];
} {
  const published: string[] = [];
  const deleted: string[] = [];
  const visibility: number[] = [];

  const queue: MessageQueuePort = {
    receive: async () => [incoming],
    delete: async () => {
      throw new Error('DeleteMessage failed');
    },
    publish: async (url) => {
      published.push(url);
    },
    changeVisibility: async (_url, _receiptHandle, timeoutSeconds) => {
      visibility.push(timeoutSeconds);
    },
    getQueueAttributes: async () => ({ approximateNumberOfMessages: 0, oldestMessageAgeSeconds: 0 })
  };

  const unitOfWork: UnitOfWork = {
    run: async (work) => work({} as TransactionContext),
    current: () => ({}) as TransactionContext
  };

  const inbox: InboxRepository = {
    findByConsumerAndMessageId: async () => undefined,
    insertIfAbsent: async () => ({ inserted: true })
  };

  const transactionId = newUuidV7();
  const useCase = {
    execute: async () => ({
      transactionId,
      status: WagerTransactionStatus.Processed,
      idempotentReplay: false
    }),
    recordFailed: async () => ({
      transactionId,
      status: WagerTransactionStatus.Failed,
      idempotentReplay: false
    }),
    recordRejected: async () => ({
      transactionId,
      status: WagerTransactionStatus.Rejected,
      idempotentReplay: false
    })
  } as unknown as ProcessWagerTransactionUseCase;

  return {
    consumer: new WagerTransactionConsumer(
      settings(3),
      queue,
      unitOfWork,
      { now: async () => new Date() },
      inbox,
      useCase
    ),
    published,
    deleted,
    visibility
  };
}

describe('WagerTransactionConsumer receive limit', () => {
  test('vai para a DLQ quando o receiveCount atinge o limite aplicacional', async () => {
    const harness = consumer(3, message(3));

    await harness.consumer.runOnce();

    expect(harness.published).toEqual([DLQ_URL]);
    expect(harness.deleted).toEqual(['receipt-1']);
    expect(harness.visibility).toEqual([]);
  });

  test('devolve visibilidade quando ainda está abaixo do limite', async () => {
    const harness = consumer(3, message(2));

    await harness.consumer.runOnce();

    expect(harness.published).toEqual([]);
    expect(harness.deleted).toEqual([]);
    expect(harness.visibility).toHaveLength(1);
  });

  test('falha no delete após o commit não envia a mensagem processada para a DLQ', async () => {
    const harness = consumerWithDeleteFailure(message(1));

    await harness.consumer.runOnce();

    expect(harness.published).toEqual([]);
    expect(harness.deleted).toEqual([]);
    expect(harness.visibility).toHaveLength(1);
  });

  test('não vaza valor monetário no log ao dead-letterar erro de domínio', async () => {
    const originalError = console.error;
    const lines: string[] = [];
    console.error = (value?: unknown) => {
      lines.push(String(value));
    };

    try {
      const harness = consumer(
        3,
        message(1),
        new InvalidMoneyError('Invalid monetary amount: -5.00')
      );

      await harness.consumer.runOnce();

      expect(harness.published).toEqual([DLQ_URL]);
      const output = lines.join('\n');
      expect(output).toContain('consumer_dead_lettered');
      expect(output).not.toContain('-5.00');
      expect(output).toContain('InvalidMoneyError');
    } finally {
      console.error = originalError;
    }
  });

  test('mesmo messageId com JSON reordenado é duplicata, não payload divergente', async () => {
    const messageId = `msg-${newUuidV7()}`;
    const data = {
      providerId: 'provider',
      externalTransactionId: 'ext-reordered',
      idempotencyKey: 'key-reordered',
      playerId: newUuidV7(),
      walletId: newUuidV7(),
      roundId: 'round',
      gameId: 'game',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' }
    };
    const first: QueueMessage = {
      body: JSON.stringify({ messageId, type: 'WagerTransactionRequested', data }),
      messageId,
      receiptHandle: 'receipt-reordered-1',
      receiveCount: 1
    };
    const second: QueueMessage = {
      body: JSON.stringify({
        data: {
          gameId: data.gameId,
          roundId: data.roundId,
          money: { currency: data.money.currency, amount: data.money.amount },
          kind: data.kind,
          walletId: data.walletId,
          playerId: data.playerId,
          idempotencyKey: data.idempotencyKey,
          externalTransactionId: data.externalTransactionId,
          providerId: data.providerId
        },
        type: 'WagerTransactionRequested',
        messageId
      }),
      messageId,
      receiptHandle: 'receipt-reordered-2',
      receiveCount: 1
    };

    let incoming = first;
    let stored: InboxMessage | undefined;
    const published: string[] = [];
    const deleted: string[] = [];
    let executions = 0;

    const queue: MessageQueuePort = {
      receive: async () => [incoming],
      delete: async (_url, receiptHandle) => {
        deleted.push(receiptHandle);
      },
      publish: async (url) => {
        published.push(url);
      },
      changeVisibility: async () => undefined,
      getQueueAttributes: async () => ({
        approximateNumberOfMessages: 0,
        oldestMessageAgeSeconds: 0
      })
    };
    const unitOfWork: UnitOfWork = {
      run: async (work) => work({} as TransactionContext),
      current: () => ({}) as TransactionContext
    };
    const inbox: InboxRepository = {
      findByConsumerAndMessageId: async () => stored,
      insertIfAbsent: async (message) => {
        if (stored !== undefined) {
          return { inserted: false, existing: stored };
        }
        stored = message;
        return { inserted: true };
      }
    };
    const useCase = {
      execute: async () => {
        executions += 1;
        return {
          transactionId: newUuidV7(),
          status: WagerTransactionStatus.Processed,
          idempotentReplay: false
        };
      }
    } as unknown as ProcessWagerTransactionUseCase;

    const instance = new WagerTransactionConsumer(
      settings(3),
      queue,
      unitOfWork,
      { now: async () => new Date() },
      inbox,
      useCase
    );

    await instance.runOnce();
    incoming = second;
    await instance.runOnce();

    expect(published).toEqual([]);
    expect(deleted).toEqual(['receipt-reordered-1', 'receipt-reordered-2']);
    expect(executions).toBe(1);
  });
});
