import { INestApplication, ValidationPipe } from '@nestjs/common';
import { hostname } from 'node:os';
import { LOGGER, METRICS, PERSISTENCE_ERROR_TRANSLATOR } from '../../application/ports/tokens';
import type { LoggerPort, MetricsPort } from '../../application/ports/observability.port';
import type { PersistenceErrorTranslatorPort } from '../../application/ports/persistence-error-translator.port';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';
import { CorrelationIdInterceptor } from './interceptors/correlation-id.interceptor';
import { StructuredLoggingInterceptor } from './interceptors/structured-logging.interceptor';
import { NestLoggerAdapter } from './logging/nest-logger.adapter';

export function configureApp(app: INestApplication): INestApplication {
  const logger = app.get<LoggerPort>(LOGGER);
  const metrics = app.get<MetricsPort>(METRICS);
  const translator = app.get<PersistenceErrorTranslatorPort>(PERSISTENCE_ERROR_TRANSLATOR);

  app.useLogger(new NestLoggerAdapter(logger));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false }
    })
  );

  app.useGlobalInterceptors(
    new CorrelationIdInterceptor(),
    new StructuredLoggingInterceptor(logger)
  );
  app.useGlobalFilters(new AllExceptionsFilter(logger, metrics, translator));

  app.use(
    (
      _request: unknown,
      response: { setHeader(name: string, value: string): void },
      next: () => void
    ): void => {
      const instanceId = process.env.INSTANCE_ID ?? `${hostname()}:${process.pid}`;
      response.setHeader('X-Instance-Id', instanceId);
      next();
    }
  );

  app.enableShutdownHooks();
  return app;
}
