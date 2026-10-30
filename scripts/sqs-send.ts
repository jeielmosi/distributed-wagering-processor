import { readFile } from 'node:fs/promises';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { sha256Hex } from '../src/shared/hash/canonical-hash';

interface Envelope {
  messageId?: unknown;
  type?: unknown;
  data?: Record<string, unknown>;
}

function argument(name: string): string | undefined {
  const index = Bun.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : Bun.argv[index + 1];
}

async function main(): Promise<void> {
  const file = argument('file');
  const wallet = argument('wallet');
  if (file === undefined) {
    throw new Error('Usage: bun run sqs:send -- --file <mensagem.json> [--wallet <walletId>]');
  }

  const raw = await readFile(file, 'utf8');
  const envelope = JSON.parse(raw) as Envelope;
  if (
    typeof envelope.messageId !== 'string' ||
    envelope.messageId.trim().length === 0 ||
    envelope.type !== 'WagerTransactionRequested' ||
    typeof envelope.data !== 'object' ||
    envelope.data === null
  ) {
    throw new Error('Message must contain messageId, type=WagerTransactionRequested and data');
  }

  const walletId = wallet ?? envelope.data.walletId;
  if (typeof walletId !== 'string' || walletId.trim().length === 0) {
    throw new Error('walletId is required (use --wallet or data.walletId)');
  }
  envelope.data.walletId = walletId;

  const endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
  const queueUrl =
    process.env.SQS_WAGER_QUEUE_URL ?? `${endpoint}/000000000000/wager-transactions.fifo`;
  const client = new SQSClient({
    endpoint,
    region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test'
    }
  });

  try {
    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: walletId,
        MessageDeduplicationId: sha256Hex(envelope.messageId)
      })
    );
    console.log(`Published ${envelope.messageId} to ${queueUrl}`);
  } finally {
    client.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
