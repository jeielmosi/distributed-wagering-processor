import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import request from 'supertest';
import { ensurePostgres, PostgresHarness } from './integration/support/postgres-harness';
import { createTestApplication, TestApplication } from './integration/support/app-harness';

describe('App bootstrap (e2e)', () => {
  let harness: PostgresHarness;
  let application: TestApplication;

  beforeAll(async () => {
    harness = await ensurePostgres();
    application = await createTestApplication(harness, 'app_bootstrap');
  }, 180000);

  afterAll(async () => {
    await application?.close();
    await harness?.stop();
  }, 180000);

  test('ecoa X-Instance-Id em todas as respostas', async () => {
    const response = await request(application.app.getHttpServer()).get('/__smoke__');

    expect(response.status).toBe(404);
    expect(response.headers['x-instance-id']).toBeDefined();
  });

  test('rota inexistente retorna 404 com ROUTE_NOT_FOUND', async () => {
    const response = await request(application.app.getHttpServer()).get('/__missing__');

    expect(response.status).toBe(404);
    expect(response.body.failureCode).toBe('ROUTE_NOT_FOUND');
  });

  test('health/live responde 200', async () => {
    const response = await request(application.app.getHttpServer()).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'OK' });
  });
});
