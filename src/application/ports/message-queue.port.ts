export interface QueueMessage {
  body: string;
  messageId: string;
  receiptHandle: string;
  receiveCount: number;
  attributes?: Record<string, string>;
}

export interface ReceiveOptions {
  maxMessages?: number;
  visibilityTimeoutSeconds?: number;
  waitTimeSeconds?: number;
}

export interface PublishOptions {
  groupId: string;
  deduplicationId: string;
}

export interface QueueAttributes {
  approximateNumberOfMessages: number;
  oldestMessageAgeSeconds: number;
}

export interface MessageQueuePort {
  receive(queueUrl: string, options?: ReceiveOptions): Promise<QueueMessage[]>;
  delete(queueUrl: string, receiptHandle: string): Promise<void>;
  changeVisibility(queueUrl: string, receiptHandle: string, timeoutSeconds: number): Promise<void>;
  publish(queueUrl: string, body: string, options: PublishOptions): Promise<void>;
  getQueueAttributes(queueUrl: string): Promise<QueueAttributes>;
}
