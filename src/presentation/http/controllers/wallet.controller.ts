import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res
} from '@nestjs/common';
import { CreateWalletUseCase } from '../../../application/use-cases/create-wallet.use-case';
import { GetLedgerUseCase } from '../../../application/use-cases/get-ledger.use-case';
import { GetWalletUseCase } from '../../../application/use-cases/get-wallet.use-case';
import { ReconcileWalletUseCase } from '../../../application/use-cases/reconcile-wallet.use-case';
import { CorrelationId } from '../decorators/correlation-id.decorator';
import { CreateWalletDto } from '../dto/create-wallet.dto';
import { LedgerQueryDto } from '../dto/ledger-query.dto';

interface StatusResponse {
  status(code: number): void;
}

@Controller('wallets')
export class WalletController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly getLedger: GetLedgerUseCase,
    private readonly reconcileWallet: ReconcileWalletUseCase
  ) {}

  @Post()
  async create(
    @Body() body: CreateWalletDto,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: StatusResponse
  ) {
    const wallet = await this.createWallet.execute({
      playerId: body.playerId,
      initialBalance: body.initialBalance,
      correlationId
    });
    response.status(HttpStatus.CREATED);
    return wallet;
  }

  @Get(':walletId')
  get(@Param('walletId', new ParseUUIDPipe()) walletId: string) {
    return this.getWallet.execute(walletId);
  }

  @Get(':walletId/ledger')
  ledger(@Param('walletId', new ParseUUIDPipe()) walletId: string, @Query() query: LedgerQueryDto) {
    return this.getLedger.execute({ walletId, cursor: query.cursor, limit: query.limit });
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  reconcile(@Param('walletId', new ParseUUIDPipe()) walletId: string) {
    return this.reconcileWallet.execute(walletId);
  }
}
