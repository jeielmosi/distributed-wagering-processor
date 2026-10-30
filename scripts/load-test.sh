#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BASE_URL="${K6_BASE_URL:-http://localhost:3000}"
PROVIDER_ID="${K6_PROVIDER_ID:-provider-load}"
CURRENCY="${K6_CURRENCY:-BRL}"
AMOUNT="${K6_AMOUNT:-1.00}"
INITIAL_BALANCE="${INITIAL_BALANCE:-1000000.00}"

WARMUP_VUS="${WARMUP_VUS:-5}"
WARMUP_DURATION="${WARMUP_DURATION:-15s}"
MAIN_VUS="${MAIN_VUS:-10}"
MAIN_DURATION="${MAIN_DURATION:-60s}"
SLEEP_SECONDS="${K6_SLEEP_SECONDS:-0}"

START_STACK="${START_STACK:-1}"
SKIP_BUILD="${SKIP_BUILD:-0}"
KEEP_STACK="${KEEP_STACK:-0}"
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-60}"
OUTBOX_DRAIN_TIMEOUT_SECONDS="${OUTBOX_DRAIN_TIMEOUT_SECONDS:-60}"
LOAD_RUNNER="${LOAD_RUNNER:-auto}"

STAMP="$(date +%Y%m%d-%H%M%S)"
RESULTS_DIR="${RESULTS_DIR:-$ROOT_DIR/load/results/$STAMP}"
mkdir -p "$RESULTS_DIR"
K6_EXIT_CODE=0

log() {
  printf '[load-test] %s\n' "$*"
}

fail() {
  printf '[load-test] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "comando obrigatório não encontrado: $1"
}

metric_value() {
  local name="$1"
  local file="$2"
  awk -v name="$name" '$1 == name || index($1, name "{") == 1 { print $2; exit }' "$file"
}

status_metric() {
  local status="$1"
  local file="$2"
  grep -m1 "^wager_transactions_total{status=\"$status\"" "$file" | awk '{ print $2 }' || true
}

wait_for_ready() {
  local deadline=$((SECONDS + READY_TIMEOUT_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/health/ready" || true)"
    if [ "$code" = "200" ]; then
      log "health/ready OK"
      return 0
    fi
    sleep 1
  done
  fail "health/ready não ficou 200 em ${READY_TIMEOUT_SECONDS}s"
}

wait_for_outbox_drain() {
  local file="$1"
  local deadline=$((SECONDS + OUTBOX_DRAIN_TIMEOUT_SECONDS))
  local pending
  while [ "$SECONDS" -lt "$deadline" ]; do
    curl -sS "$BASE_URL/metrics" > "$file"
    pending="$(metric_value outbox_pending "$file")"
    if [ "$pending" = "0" ]; then
      log "outbox drenada"
      return 0
    fi
    sleep 1
  done
  log "AVISO: outbox ainda com pendências após ${OUTBOX_DRAIN_TIMEOUT_SECONDS}s"
}

create_wallet() {
  local player_id
  if command -v uuidgen >/dev/null 2>&1; then
    player_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
  else
    player_id="$(bun -e 'console.log(crypto.randomUUID())')"
  fi

  local response body code
  response="$(curl -sS -w '\n%{http_code}' -X POST "$BASE_URL/wallets" \
    -H 'Content-Type: application/json' \
    -d "{\"playerId\":\"$player_id\",\"initialBalance\":{\"amount\":\"$INITIAL_BALANCE\",\"currency\":\"$CURRENCY\"}}")"
  body="${response%$'\n'*}"
  code="${response##*$'\n'}"

  if [ "$code" != "201" ]; then
    printf '%s\n' "$body" >&2
    fail "falha ao criar wallet (HTTP $code)"
  fi

  WALLET_ID="$(printf '%s' "$body" | jq -r '.id // empty')"
  PLAYER_ID="$(printf '%s' "$body" | jq -r '.playerId // empty')"
  [ -n "$PLAYER_ID" ] && [ -n "$WALLET_ID" ] || fail "resposta de wallet sem playerId/id"

  printf '%s\n' "$body" > "$RESULTS_DIR/wallet.json"
  log "wallet criada: $WALLET_ID (player $PLAYER_ID, saldo $INITIAL_BALANCE $CURRENCY)"
}

resolve_runner() {
  if [ "$LOAD_RUNNER" = "host" ]; then
    require_command k6
    printf 'host\n'
    return
  fi
  if [ "$LOAD_RUNNER" = "docker" ]; then
    require_command docker
    printf 'docker\n'
    return
  fi
  if command -v k6 >/dev/null 2>&1; then
    printf 'host\n'
  else
    require_command docker
    printf 'docker\n'
  fi
}

run_k6() {
  local label="$1"
  local vus="$2"
  local duration="$3"
  local output="$RESULTS_DIR/$label.log"

  log "k6 $label: ${vus} VUs / ${duration} (runner: $RUNNER)"
  set +e
  if [ "$RUNNER" = "host" ]; then
    K6_BASE_URL="$BASE_URL" \
    K6_PLAYER_ID="$PLAYER_ID" \
    K6_WALLET_ID="$WALLET_ID" \
    K6_PROVIDER_ID="$PROVIDER_ID" \
    K6_CURRENCY="$CURRENCY" \
    K6_AMOUNT="$AMOUNT" \
    K6_VUS="$vus" \
    K6_DURATION="$duration" \
    K6_SLEEP_SECONDS="$SLEEP_SECONDS" \
      bun run test:load > "$output" 2>&1
  else
    K6_BASE_URL="$BASE_URL" \
    K6_PLAYER_ID="$PLAYER_ID" \
    K6_WALLET_ID="$WALLET_ID" \
    K6_PROVIDER_ID="$PROVIDER_ID" \
    K6_CURRENCY="$CURRENCY" \
    K6_AMOUNT="$AMOUNT" \
    K6_VUS="$vus" \
    K6_DURATION="$duration" \
    K6_SLEEP_SECONDS="$SLEEP_SECONDS" \
      bun run test:load:docker > "$output" 2>&1
  fi
  local rc=$?
  set -e
  K6_EXIT_CODE=$rc
  if [ "$rc" -ne 0 ]; then
    log "AVISO: k6 $label saiu com código $rc; resumo será gerado mesmo assim"
  fi

  tail -n 35 "$output"
}

cleanup() {
  if [ "$START_STACK" = "1" ] && [ "$KEEP_STACK" != "1" ]; then
    log "derrubando stack (KEEP_STACK=1 para manter)"
    docker compose down >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

require_command curl
require_command jq
require_command bun
RUNNER="$(resolve_runner)"
log "resultados em $RESULTS_DIR"

if [ "$START_STACK" = "1" ]; then
  require_command docker
  log "subindo stack (build=$([ "$SKIP_BUILD" = "1" ] && echo skip || echo on))"
  if [ "$SKIP_BUILD" = "1" ]; then
    docker compose up -d
  else
    docker compose up -d --build
  fi
fi

wait_for_ready
create_wallet
curl -sS "$BASE_URL/metrics" > "$RESULTS_DIR/metrics-warmup-before.txt"

log "aquecimento (descartado)"
run_k6 warmup "$WARMUP_VUS" "$WARMUP_DURATION"
curl -sS "$BASE_URL/metrics" > "$RESULTS_DIR/metrics-warmup-after.txt"
wait_for_outbox_drain "$RESULTS_DIR/outbox-warmup-wait.txt"

curl -sS "$BASE_URL/metrics" > "$RESULTS_DIR/metrics-before.txt"
log "cenário principal"
run_k6 main "$MAIN_VUS" "$MAIN_DURATION"
curl -sS "$BASE_URL/metrics" > "$RESULTS_DIR/metrics-after.txt"

log "aguardando outbox drenar"
wait_for_outbox_drain "$RESULTS_DIR/outbox-main-wait.txt"
curl -sS "$BASE_URL/metrics" > "$RESULTS_DIR/metrics-drained.txt"
curl -sS -X POST "$BASE_URL/wallets/$WALLET_ID/reconciliation" > "$RESULTS_DIR/reconciliation.json"

processed_before="$(status_metric PROCESSED "$RESULTS_DIR/metrics-before.txt")"
processed_after="$(status_metric PROCESSED "$RESULTS_DIR/metrics-after.txt")"
rejected_after="$(status_metric REJECTED "$RESULTS_DIR/metrics-after.txt")"
failed_after="$(status_metric FAILED "$RESULTS_DIR/metrics-after.txt")"
outbox_after="$(metric_value outbox_pending "$RESULTS_DIR/metrics-after.txt")"
outbox_dead_lettered="$(metric_value outbox_dead_lettered "$RESULTS_DIR/metrics-after.txt")"
lock_timeouts="$(metric_value db_lock_timeouts_total "$RESULTS_DIR/metrics-after.txt")"
deadlocks="$(metric_value db_deadlocks_total "$RESULTS_DIR/metrics-after.txt")"
idempotency_hits="$(metric_value wager_idempotency_hits_total "$RESULTS_DIR/metrics-after.txt")"
lock_sum_before="$(metric_value db_lock_wait_seconds_sum "$RESULTS_DIR/metrics-before.txt")"
lock_sum_after="$(metric_value db_lock_wait_seconds_sum "$RESULTS_DIR/metrics-after.txt")"
lock_count_before="$(metric_value db_lock_wait_seconds_count "$RESULTS_DIR/metrics-before.txt")"
lock_count_after="$(metric_value db_lock_wait_seconds_count "$RESULTS_DIR/metrics-after.txt")"

lock_avg_ms="$(awk -v sb="$lock_sum_before" -v sa="$lock_sum_after" -v cb="$lock_count_before" -v ca="$lock_count_after" 'BEGIN {
  d = ca - cb;
  if (d > 0) printf "%.1f", ((sa - sb) / d) * 1000;
  else printf "n/a";
}')"

{
  echo
  echo "=== Resumo ==="
  echo "Wallet: $WALLET_ID"
  echo "PROCESSED: ${processed_before:-?} -> ${processed_after:-?}"
  echo "REJECTED: ${rejected_after:-0}"
  echo "FAILED: ${failed_after:-0}"
  echo "Idempotency hits: ${idempotency_hits:-0}"
  echo "Outbox pendente após carga: ${outbox_after:-?}; dead-lettered: ${outbox_dead_lettered:-0}"
  echo "Lock timeouts: ${lock_timeouts:-0}; deadlocks: ${deadlocks:-0}; lock wait médio: ${lock_avg_ms} ms"
  echo "DLQs:"
  grep '^sqs_dlq_messages' "$RESULTS_DIR/metrics-drained.txt" || true
  echo "Reconciliação:"
  jq . "$RESULTS_DIR/reconciliation.json"
  echo
  echo "k6 main:"
  grep -E 'load_transactions_total|http_req_duration|http_req_failed|iterations' "$RESULTS_DIR/main.log" || true
  echo
  echo "Artefatos: $RESULTS_DIR"
} | tee "$RESULTS_DIR/summary.txt"

exit "$K6_EXIT_CODE"
