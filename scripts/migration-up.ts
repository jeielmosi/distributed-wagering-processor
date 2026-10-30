import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infrastructure/persistence/mikro-orm.config';

async function main(): Promise<void> {
  const orm = await MikroORM.init(config);
  try {
    const migrator = orm.getMigrator();
    const pending = await migrator.getPendingMigrations();
    if (pending.length === 0) {
      console.log('No pending migrations.');
      return;
    }
    await migrator.up();
    console.log(`Applied ${pending.length} migration(s).`);
  } finally {
    await orm.close(true);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
