import { CanActivate, Injectable } from '@nestjs/common';

@Injectable()
export class NoopAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
