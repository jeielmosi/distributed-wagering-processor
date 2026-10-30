#!/bin/sh
set -eu

ENDPOINT="${SQS_ENDPOINT:-http://localstack:4566}"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="$REGION"

aws_sqs() {
  aws --endpoint-url "$ENDPOINT" sqs "$@"
}

queue_url() {
  aws_sqs get-queue-url --queue-name "$1" --query QueueUrl --output text
}

queue_arn() {
  aws_sqs get-queue-attributes --queue-url "$1" --attribute-names QueueArn \
    --query 'Attributes.QueueArn' --output text
}

aws_sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true >/dev/null
aws_sqs create-queue --queue-name wagering-events-dlq.fifo \
  --attributes FifoQueue=true >/dev/null

WAGER_DLQ_URL=$(queue_url wager-transactions-dlq.fifo)
EVENTS_DLQ_URL=$(queue_url wagering-events-dlq.fifo)
WAGER_DLQ_ARN=$(queue_arn "$WAGER_DLQ_URL")
EVENTS_DLQ_ARN=$(queue_arn "$EVENTS_DLQ_URL")

aws_sqs create-queue --queue-name wager-transactions.fifo \
  --attributes FifoQueue=true >/dev/null
aws_sqs create-queue --queue-name wagering-events.fifo \
  --attributes FifoQueue=true >/dev/null

WAGER_QUEUE_URL=$(queue_url wager-transactions.fifo)
EVENTS_QUEUE_URL=$(queue_url wagering-events.fifo)

WAGER_ATTRS=$(mktemp)
EVENTS_ATTRS=$(mktemp)
trap 'rm -f "$WAGER_ATTRS" "$EVENTS_ATTRS"' EXIT

cat >"$WAGER_ATTRS" <<EOF
{
  "ContentBasedDeduplication": "false",
  "VisibilityTimeout": "60",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"$WAGER_DLQ_ARN\",\"maxReceiveCount\":\"5\"}"
}
EOF

cat >"$EVENTS_ATTRS" <<EOF
{
  "ContentBasedDeduplication": "false",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"$EVENTS_DLQ_ARN\",\"maxReceiveCount\":\"5\"}"
}
EOF

aws_sqs set-queue-attributes --queue-url "$WAGER_QUEUE_URL" \
  --attributes "file://$WAGER_ATTRS"
aws_sqs set-queue-attributes --queue-url "$EVENTS_QUEUE_URL" \
  --attributes "file://$EVENTS_ATTRS"

echo "SQS queues ready at $ENDPOINT"
