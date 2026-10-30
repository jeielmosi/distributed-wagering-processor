import { Controller, Get, Header } from '@nestjs/common';
import { metrics } from './metrics';

@Controller('metrics')
export class MetricsController {
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics(): Promise<string> {
    return metrics.render();
  }
}
