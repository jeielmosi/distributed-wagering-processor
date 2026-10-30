import { InboxMessage } from '../../domain/messaging/inbox-message';
import { TransactionContext } from './transaction-context';

export interface InboxInsertResult {
  inserted: boolean;
  existing?: InboxMessage;
}

export interface InboxRepository {
  findByConsumerAndMessageId(
    consumerName: string,
    messageId: string,
    ctx?: TransactionContext
  ): Promise<InboxMessage | undefined>;
  insertIfAbsent(inbox: InboxMessage, ctx?: TransactionContext): Promise<InboxInsertResult>;
}
