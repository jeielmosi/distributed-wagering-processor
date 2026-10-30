import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { MikroORM } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import { createMikroOrmConfig } from '../../../src/infrastructure/persistence/mikro-orm.config';

const TEMPLATE_DATABASE = 'wagering_template';
const POSTGRES_IMAGE = 'postgres:16.14-alpine';

export interface SuiteDatabase {
  readonly url: string;
  readonly databaseName: string;
  readonly orm: MikroORM;
  close(): Promise<void>;
}

export interface PostgresHarness {
  createSuiteDatabase(label: string, options?: { migrated?: boolean }): Promise<SuiteDatabase>;
  stop(): Promise<void>;
}

let container: StartedPostgreSqlContainer | undefined;
let admin: Client | undefined;
let started: Promise<PostgresHarness> | undefined;

function databaseName(label: string): string {
  const normalized = label
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .slice(0, 24);
  return `suite_${normalized}_${Bun.randomUUIDv7().replace(/-/g, '').slice(0, 12)}`;
}

async function runMigrations(url: string): Promise<void> {
  const orm = await MikroORM.init(createMikroOrmConfig({ clientUrl: url }));
  try {
    await orm.getMigrator().up();
  } finally {
    await orm.close(true);
  }
}

function adminClient(startedContainer: StartedPostgreSqlContainer): Client {
  if (admin === undefined) {
    admin = new Client({
      host: startedContainer.getHost(),
      port: startedContainer.getMappedPort(5432),
      user: startedContainer.getUsername(),
      password: startedContainer.getPassword(),
      database: TEMPLATE_DATABASE
    });
  }
  return admin;
}

async function start(): Promise<PostgresHarness> {
  const startedContainer = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase(TEMPLATE_DATABASE)
    .withUsername('postgres')
    .withPassword('postgres')
    .withStartupTimeout(180000)
    .start();
  container = startedContainer;

  const templateUrl = startedContainer.getConnectionUri();
  await runMigrations(templateUrl);

  const client = adminClient(startedContainer);
  await client.connect();

  const harness: PostgresHarness = {
    async createSuiteDatabase(label, options = {}) {
      const name = databaseName(label);
      if (options.migrated === false) {
        await client.query(`create database "${name}"`);
      } else {
        await client.query(`create database "${name}" template "${TEMPLATE_DATABASE}"`);
      }
      const url = startedContainer
        .getConnectionUri()
        .replace(new RegExp(`/${TEMPLATE_DATABASE}(\\?|$)`), `/${name}$1`);
      const orm = await MikroORM.init(createMikroOrmConfig({ clientUrl: url }));

      return {
        url,
        databaseName: name,
        orm,
        async close() {
          await orm.close(true);
          await client.query(
            'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
            [name]
          );
          await client.query(`drop database if exists "${name}"`);
        }
      };
    },
    async stop() {
      if (admin !== undefined) {
        await admin.end();
        admin = undefined;
      }
      if (container !== undefined) {
        await container.stop();
        container = undefined;
      }
      started = undefined;
    }
  };

  return harness;
}

export async function ensurePostgres(): Promise<PostgresHarness> {
  if (started === undefined) {
    started = start();
  }
  return started;
}
