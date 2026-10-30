import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../../src/app.module';
import { configureApp } from '../../../src/presentation/http/configure-app';
import { PostgresHarness, SuiteDatabase } from './postgres-harness';

export interface TestApplication {
  app: INestApplication;
  database: SuiteDatabase;
  close(): Promise<void>;
}

function applyEnvironment(environment: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

export async function createApplicationOnDatabase(
  database: SuiteDatabase,
  environment: Record<string, string> = {}
): Promise<INestApplication> {
  const restore = applyEnvironment({ ...environment, DATABASE_URL: database.url });
  try {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = configureApp(moduleRef.createNestApplication());
    await app.init();
    return app;
  } finally {
    restore();
  }
}

export async function createTestApplication(
  harness: PostgresHarness,
  label: string,
  environment: Record<string, string> = {}
): Promise<TestApplication> {
  const database = await harness.createSuiteDatabase(label);
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = database.url;

  const restore = (): void => {
    if (previousUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousUrl;
    }
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };

  try {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = configureApp(moduleRef.createNestApplication());
    await app.init();

    return {
      app,
      database,
      async close() {
        await app.close();
        restore();
        await database.close();
      }
    };
  } catch (error) {
    restore();
    await database.close();
    throw error;
  }
}
