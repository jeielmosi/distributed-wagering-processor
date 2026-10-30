import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { FailureCode } from '../../shared/errors/failure-code';
import {
  PersistenceConflict,
  UniqueConstraintConflictError
} from '../../application/errors/persistence.errors';
import { hashWagerPayload, sha256Hex } from '../../shared/hash/canonical-hash';
import type { ProcessWagerTransactionCommand } from '../../application/use-cases/process-wager-transaction.types';
import {
  classifyMessageError,
  MessageFailureKind,
  InboxPayloadMismatchError,
  visibilityBackoffSeconds
} from '../../application/messaging/consumer-errors';
import {
  InvalidQueueMessageError,
  parseWagerTransactionMessage,
  ParsedWagerTransactionMessage
} from '../../application/messaging/wager-transaction-message';
import { ProcessWagerTransactionUseCase } from '../../application/use-cases/process-wager-transaction.use-case';
import type { InboxRepository } from '../../application/ports/inbox.repository';
import type { MessageQueuePort, QueueMessage } from '../../application/ports/message-queue.port';
import type { Clock } from '../../application/ports/clock.port';
import type { UnitOfWork } from '../../application/ports/transaction-context';
import {
  DlqQueueName,
  InboxDuplicateOutcome,
  metrics,
  QueueName,
  RetryWorker
} from '../observability/metrics';
import { logger } from '../observability/structured-logger';
import { safeErrorFields } from '../observability/safe-error';
import {
  CLOCK,
  INBOX_REPOSITORY,
  MESSAGE_QUEUE,
  MESSAGING_SETTINGS,
  UNIT_OF_WORK
} from './messaging.tokens';
import type { MessagingSettings } from './messaging.config';

enum BusinessOutcomeKind {
  Processed = 'PROCESSED',
  Duplicate = 'DUPLICATE'
}

type BusinessOutcome =
  | { kind: BusinessOutcomeKind.Processed; transactionId: string }
  | { kind: BusinessOutcomeKind.Duplicate; transactionId?: undefined };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

@Injectable()
export class WagerTransactionConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;
  private stopping = false;

  constructor(
    @Inject(MESSAGING_SETTINGS) private readonly settings: MessagingSettings,
    @Inject(MESSAGE_QUEUE) private readonly queue: MessageQueuePort,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(INBOX_REPOSITORY) private readonly inbox: InboxRepository,
    @Inject(ProcessWagerTransactionUseCase)
    private readonly useCase: ProcessWagerTransactionUseCase
  ) {}

  onApplicationBootstrap(): void {
    if (this.settings.enabled) {
      this.start();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.loop !== undefined) {
      return;
    }
    this.stopping = false;
    this.loop = this.poll();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    if (this.loop === undefined) {
      return;
    }
    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, this.settings.drainTimeoutMs);
    });
    await Promise.race([this.loop, timeout]);
    this.loop = undefined;
  }

  async runOnce(): Promise<number> {
    const messages = await this.queue.receive(this.settings.wagerQueueUrl, {
      maxMessages: this.settings.maxNumberOfMessages,
      visibilityTimeoutSeconds: this.settings.visibilityTimeoutSeconds,
      waitTimeSeconds: 0
    });
    for (const message of messages) {
      await this.processMessage(message);
    }
    return messages.length;
  }

  private async poll(): Promise<void> {
    while (!this.stopping) {
      try {
        const received = await this.runOnce();
        if (received === 0) {
          await sleep(this.settings.pollIntervalMs, this.abort.signal);
        }
      } catch (error) {
        logger.error('consumer_poll_failed', {
          worker: RetryWorker.Consumer,
          reason: safeErrorFields(error)
        });
        await sleep(this.settings.pollIntervalMs, this.abort.signal);
      }
    }
  }

  private async processMessage(message: QueueMessage): Promise<void> {
    let parsed: ParsedWagerTransactionMessage | undefined;
    try {
      parsed = parseWagerTransactionMessage(message.body, this.fallbackCorrelationId(message));
    } catch (error) {
      await this.deadLetter(message, undefined, error);
      return;
    }

    try {
      const outcome = await this.runWithConflictRetry(
        parsed.command,
        parsed.messageId,
        parsed.correlationId
      );
      logger.info('consumer_message_processed', {
        worker: RetryWorker.Consumer,
        messageId: parsed.messageId,
        correlationId: parsed.correlationId,
        transactionId: outcome.transactionId,
        walletId: parsed.command.walletId,
        providerId: parsed.command.providerId,
        duplicate: outcome.kind === BusinessOutcomeKind.Duplicate
      });
    } catch (error) {
      await this.handleFailure(message, parsed, error);
      return;
    }

    if (this.settings.faultAfterCommitBeforeAck) {
      process.exit(1);
    }

    try {
      await this.queue.delete(this.settings.wagerQueueUrl, message.receiptHandle);
    } catch (error) {
      // O commit já aconteceu. Devolver a mensagem é seguro: o inbox a deduplica.
      logger.error('consumer_ack_failed', {
        worker: RetryWorker.Consumer,
        messageId: parsed.messageId,
        correlationId: parsed.correlationId,
        walletId: parsed.command.walletId,
        providerId: parsed.command.providerId,
        reason: safeErrorFields(error)
      });
      await this.defer(message);
    }
  }

  private async runWithConflictRetry(
    command: ParsedWagerTransactionMessage['command'],
    messageId: string,
    correlationId: string
  ): Promise<BusinessOutcome> {
    const payloadHash = this.payloadHash(command);
    try {
      return await this.runBusinessTransaction(command, messageId, correlationId, payloadHash);
    } catch (error) {
      if (classifyMessageError(error) !== MessageFailureKind.Conflict) {
        throw error;
      }
      return this.runBusinessTransaction(command, messageId, correlationId, payloadHash);
    }
  }

  private async runBusinessTransaction(
    command: ParsedWagerTransactionMessage['command'],
    messageId: string,
    correlationId: string,
    payloadHash: string
  ): Promise<BusinessOutcome> {
    return this.unitOfWork.run(async (ctx) => {
      const now = await this.clock.now(ctx);
      const inbox = InboxMessage.receive({
        messageId,
        consumerName: this.settings.consumerName,
        payloadHash,
        correlationId,
        receivedAt: now
      });
      inbox.markProcessed(now);

      const inserted = await this.inbox.insertIfAbsent(inbox, ctx);
      if (!inserted.inserted) {
        if (inserted.existing?.payloadHash !== payloadHash) {
          metrics.inboxDuplicate(InboxDuplicateOutcome.PayloadMismatch);
          throw new InboxPayloadMismatchError(messageId);
        }
        metrics.inboxDuplicate(InboxDuplicateOutcome.Duplicate);
        return { kind: BusinessOutcomeKind.Duplicate };
      }

      const result = await this.useCase.execute(command, ctx);
      return { kind: BusinessOutcomeKind.Processed, transactionId: result.transactionId };
    });
  }

  private async handleFailure(
    message: QueueMessage,
    parsed: ParsedWagerTransactionMessage | undefined,
    error: unknown
  ): Promise<void> {
    const kind = classifyMessageError(error);

    if (kind === MessageFailureKind.Transient) {
      await this.retryOrDeadLetter(message, parsed, error);
      return;
    }

    if (kind === MessageFailureKind.Conflict) {
      if (error instanceof UniqueConstraintConflictError) {
        const failureCode =
          error.conflict === PersistenceConflict.Reversal
            ? FailureCode.ReferenceAlreadyReverted
            : error.conflict === PersistenceConflict.Settlement
              ? FailureCode.ReferenceAlreadySettled
              : undefined;
        if (failureCode !== undefined && parsed !== undefined) {
          try {
            await this.recordTerminalWithInbox(parsed, message, failureCode);
            await this.queue.delete(this.settings.wagerQueueUrl, message.receiptHandle);
            return;
          } catch (recordError) {
            if (classifyMessageError(recordError) === MessageFailureKind.Transient) {
              await this.retryOrDeadLetter(message, parsed, recordError);
              return;
            }
          }
        }
      }
      await this.deadLetter(message, parsed, error);
      return;
    }

    if (kind === MessageFailureKind.Permanent) {
      await this.deadLetter(message, parsed, error);
      return;
    }

    if (parsed === undefined) {
      await this.deadLetter(message, undefined, error);
      return;
    }

    try {
      await this.recordTerminalWithInbox(parsed, message);
      await this.deadLetter(message, parsed, error);
    } catch (recordError) {
      await this.retryOrDeadLetter(message, parsed, recordError);
    }
  }

  private async retryOrDeadLetter(
    message: QueueMessage,
    parsed: ParsedWagerTransactionMessage | undefined,
    error: unknown
  ): Promise<void> {
    if (message.receiveCount >= this.settings.consumerMaxReceiveCount) {
      await this.deadLetter(message, parsed, error);
      return;
    }
    await this.defer(message);
  }

  private async recordTerminalWithInbox(
    parsed: ParsedWagerTransactionMessage,
    message: QueueMessage,
    failureCode?: FailureCode
  ): Promise<void> {
    const payloadHash = this.payloadHash(parsed.command);
    await this.unitOfWork.run(async (ctx) => {
      const now = await this.clock.now(ctx);
      const inbox = InboxMessage.receive({
        messageId: parsed.messageId,
        consumerName: this.settings.consumerName,
        payloadHash,
        correlationId: parsed.correlationId,
        receivedAt: now
      });
      inbox.markProcessed(now);

      const inserted = await this.inbox.insertIfAbsent(inbox, ctx);
      if (!inserted.inserted) {
        if (inserted.existing?.payloadHash !== payloadHash) {
          metrics.inboxDuplicate(InboxDuplicateOutcome.PayloadMismatch);
          throw new InboxPayloadMismatchError(parsed.messageId);
        }
        metrics.inboxDuplicate(InboxDuplicateOutcome.Duplicate);
      }

      if (failureCode === undefined) {
        await this.useCase.recordFailed(parsed.command, ctx);
      } else {
        await this.useCase.recordRejected(parsed.command, failureCode, ctx);
      }
    });
  }

  private payloadHash(command: ProcessWagerTransactionCommand): string {
    return hashWagerPayload({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId
    });
  }

  private fallbackCorrelationId(message: QueueMessage): string {
    const attribute = message.attributes?.correlationId ?? message.attributes?.CorrelationId;
    if (attribute === undefined) {
      return message.messageId;
    }
    if (attribute.trim().length === 0 || attribute.length > 255) {
      throw new InvalidQueueMessageError(
        'correlationId attribute must contain between 1 and 255 characters'
      );
    }
    return attribute;
  }

  private async defer(message: QueueMessage): Promise<void> {
    metrics.retry(RetryWorker.Consumer);
    logger.warn('consumer_message_deferred', {
      worker: RetryWorker.Consumer,
      messageId: message.messageId,
      receiveCount: message.receiveCount
    });
    try {
      await this.queue.changeVisibility(
        this.settings.wagerQueueUrl,
        message.receiptHandle,
        visibilityBackoffSeconds(message.receiveCount)
      );
    } catch (error) {
      logger.error('consumer_visibility_release_failed', {
        worker: RetryWorker.Consumer,
        messageId: message.messageId,
        reason: safeErrorFields(error)
      });
    }
  }

  private async deadLetter(
    message: QueueMessage,
    parsed: ParsedWagerTransactionMessage | undefined,
    error: unknown
  ): Promise<void> {
    const groupId = parsed?.command.walletId ?? 'poison';
    try {
      await this.queue.publish(this.settings.wagerDlqUrl, message.body, {
        groupId,
        deduplicationId: sha256Hex(message.messageId)
      });
      await this.queue.delete(this.settings.wagerQueueUrl, message.receiptHandle);
      metrics.dlqMessageSent(QueueName.WagerTransactions);
      logger.error('consumer_dead_lettered', {
        worker: RetryWorker.Consumer,
        queue: DlqQueueName.WagerTransactions,
        messageId: message.messageId,
        correlationId: parsed?.correlationId,
        walletId: parsed?.command.walletId,
        providerId: parsed?.command.providerId,
        reason: safeErrorFields(error)
      });
    } catch (publishError) {
      logger.error('consumer_dead_letter_publish_failed', {
        worker: RetryWorker.Consumer,
        queue: DlqQueueName.WagerTransactions,
        messageId: message.messageId,
        walletId: parsed?.command.walletId,
        reason: safeErrorFields(publishError)
      });
      await this.defer(message);
    }
  }
}
