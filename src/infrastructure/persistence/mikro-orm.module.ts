import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { createMikroOrmConfig } from './mikro-orm.config';

export const MIKRO_ORM = Symbol('MIKRO_ORM');

@Module({
  providers: [
    {
      provide: MIKRO_ORM,
      useFactory: async (): Promise<MikroORM> => MikroORM.init(createMikroOrmConfig())
    }
  ],
  exports: [MIKRO_ORM]
})
export class MikroOrmModule implements OnApplicationShutdown {
  constructor(@Inject(MIKRO_ORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}
