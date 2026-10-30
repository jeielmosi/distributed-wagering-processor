import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infrastructure/persistence/mikro-orm.config';

async function main(): Promise<void> {
  const orm = await MikroORM.init(config);
  try {
    const name = Bun.argv[2];
    const result = await orm.getMigrator().createMigration(undefined, true, false, name);
    console.log(`Created blank migration: ${result.fileName ?? '(unknown)'}`);
    console.log('Edit the generated file to add the versioned SQL (up/down).');
  } finally {
    await orm.close(true);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
