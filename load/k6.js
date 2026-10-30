import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.K6_BASE_URL || 'http://localhost:3000';
const PLAYER_ID = __ENV.K6_PLAYER_ID;
const WALLET_ID = __ENV.K6_WALLET_ID;
const PROVIDER_ID = __ENV.K6_PROVIDER_ID || 'provider-load';
const CURRENCY = __ENV.K6_CURRENCY || 'BRL';
const AMOUNT = __ENV.K6_AMOUNT || '1.00';
const VUS = Number(__ENV.K6_VUS || 10);
const DURATION = __ENV.K6_DURATION || '30s';

const transactions = new Counter('load_transactions_total');
const rejected = new Counter('load_transactions_rejected_total');
const idempotencyReplays = new Counter('load_idempotency_replays_total');
const transactionLatency = new Trend('load_transaction_latency_ms', true);
const unexpected = new Rate('load_unexpected_responses');

export const options = {
  scenarios: {
    wagering: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION
    }
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
    load_unexpected_responses: ['rate<0.01']
  }
};

export function setup() {
  if (!PLAYER_ID || !WALLET_ID) {
    throw new Error('K6_PLAYER_ID and K6_WALLET_ID are required');
  }
  const health = http.get(`${BASE_URL}/health/ready`);
  check(health, { 'ready 200': (response) => response.status === 200 });
  return { startedAt: Date.now() };
}

function unique(prefix) {
  return `${prefix}-${Date.now()}-${__VU}-${__ITER}-${Math.floor(Math.random() * 1e9)}`;
}

export default function () {
  const externalTransactionId = unique('load-bet');
  const idempotencyKey = unique('load-idem');
  const payload = JSON.stringify({
    providerId: PROVIDER_ID,
    externalTransactionId,
    playerId: PLAYER_ID,
    walletId: WALLET_ID,
    roundId: unique('load-round'),
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: AMOUNT, currency: CURRENCY }
  });

  const response = http.post(`${BASE_URL}/wagering/transactions`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      'X-Correlation-Id': unique('load-corr')
    },
    tags: { endpoint: 'process_transaction' }
  });

  transactionLatency.add(response.timings.duration);
  transactions.add(1);

  const expected =
    response.status === 201 ||
    response.status === 200 ||
    response.status === 202 ||
    response.status === 422 ||
    response.status === 409;
  unexpected.add(!expected);

  if (response.status === 422) {
    rejected.add(1);
  }
  if (response.status === 200) {
    idempotencyReplays.add(1);
  }

  check(response, {
    'response is understood': () => expected,
    'no 5xx': () => response.status < 500
  });

  sleep(Number(__ENV.K6_SLEEP_SECONDS || 0));
}
