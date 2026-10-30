import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infrastructure/persistence/mikro-orm.config';

async function main(): Promise<void> {
  const orm = await MikroORM.init(config);
  try {
    await orm.getMigrator().down();
    console.log('Reverted the last migration.');
  } finally {
    await orm.close(true);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
