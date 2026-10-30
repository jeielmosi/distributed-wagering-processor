import { Global, Module } from '@nestjs/common';
import { LOGGER, METRICS } from '../../application/ports/tokens';
import { metrics } from './metrics';
import { logger } from './structured-logger';

@Global()
@Module({
  providers: [
    { provide: LOGGER, useValue: logger },
    { provide: METRICS, useValue: metrics }
  ],
  exports: [LOGGER, METRICS]
})
export class ObservabilityPortsModule {}
