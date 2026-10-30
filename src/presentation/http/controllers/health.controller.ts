import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { READINESS } from '../../../application/ports/tokens';
import { HealthStatus } from '../../../application/ports/readiness.port';
import type { ReadinessPort, ReadinessResult } from '../../../application/ports/readiness.port';

interface StatusResponse {
  status(code: number): void;
}

@Controller('health')
export class HealthController {
  constructor(@Inject(READINESS) private readonly readiness: ReadinessPort) {}

  @Get('live')
  live(): { status: HealthStatus } {
    return { status: HealthStatus.Ok };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: StatusResponse): Promise<ReadinessResult> {
    const result = await this.readiness.check();
    response.status(
      result.status === HealthStatus.Ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE
    );
    return result;
  }
}
