import { Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand
} from '@aws-sdk/client-sqs';
import {
  MessageQueuePort,
  PublishOptions,
  QueueAttributes,
  QueueMessage,
  ReceiveOptions
} from '../../application/ports/message-queue.port';
import { resolveSqsEndpoint } from './messaging.config';

function sqsClient(): SQSClient {
  const endpoint = resolveSqsEndpoint();
  const region = process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  return new SQSClient({
    region,
    endpoint,
    ...(accessKeyId === undefined || secretAccessKey === undefined
      ? {}
      : { credentials: { accessKeyId, secretAccessKey } })
  });
}

@Injectable()
export class SqsMessageQueueAdapter implements MessageQueuePort, OnModuleDestroy {
  private readonly client = sqsClient();

  async receive(queueUrl: string, options: ReceiveOptions = {}): Promise<QueueMessage[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: options.maxMessages ?? 1,
        VisibilityTimeout: options.visibilityTimeoutSeconds,
        WaitTimeSeconds: options.waitTimeSeconds ?? 0,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        MessageAttributeNames: ['All']
      })
    );
    return (response.Messages ?? [])
      .filter(
        (
          message
        ): message is Message & { Body: string; MessageId: string; ReceiptHandle: string } =>
          message.Body !== undefined &&
          message.MessageId !== undefined &&
          message.ReceiptHandle !== undefined
      )
      .map((message) => ({
        body: message.Body,
        messageId: message.MessageId,
        receiptHandle: message.ReceiptHandle,
        receiveCount: Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10),
        attributes: message.MessageAttributes
          ? Object.fromEntries(
              Object.entries(message.MessageAttributes).map(([key, value]) => [
                key,
                value.StringValue ?? ''
              ])
            )
          : undefined
      }));
  }

  async delete(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle })
    );
  }

  async changeVisibility(
    queueUrl: string,
    receiptHandle: string,
    timeoutSeconds: number
  ): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: timeoutSeconds
      })
    );
  }

  async publish(queueUrl: string, body: string, options: PublishOptions): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageGroupId: options.groupId,
        MessageDeduplicationId: options.deduplicationId
      })
    );
  }

  async getQueueAttributes(queueUrl: string): Promise<QueueAttributes> {
    const response = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['All']
      })
    );
    const attributes = response.Attributes as Record<string, string> | undefined;
    const messages = Number.parseInt(attributes?.ApproximateNumberOfMessages ?? '0', 10);
    const age = Number.parseInt(attributes?.ApproximateAgeOfOldestMessage ?? '0', 10);
    return {
      approximateNumberOfMessages: Number.isFinite(messages) && messages > 0 ? messages : 0,
      oldestMessageAgeSeconds: Number.isFinite(age) && age > 0 ? age : 0
    };
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
