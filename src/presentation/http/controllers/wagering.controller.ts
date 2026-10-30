import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res
} from '@nestjs/common';
import { ProcessWagerTransactionUseCase } from '../../../application/use-cases/process-wager-transaction.use-case';
import type {
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionResult
} from '../../../application/use-cases/process-wager-transaction.types';
import { GetTransactionUseCase } from '../../../application/use-cases/get-transaction.use-case';
import { WagerTransactionStatus } from '../../../domain/wager-transaction/wager-transaction-status';
import type { FailureCode } from '../../../shared/errors/failure-code';
import { CorrelationId } from '../decorators/correlation-id.decorator';
import { ProcessWagerTransactionDto } from '../dto/process-wager-transaction.dto';

interface StatusResponse {
  status(code: number): void;
}

interface RejectedResponse {
  failureCode: FailureCode | undefined;
  message: string;
  correlationId: string;
  transactionId: string;
  status: WagerTransactionStatus;
  idempotentReplay: boolean;
}

@Controller()
export class WageringController {
  constructor(
    private readonly processTransaction: ProcessWagerTransactionUseCase,
    private readonly getTransaction: GetTransactionUseCase
  ) {}

  @Post('wagering/transactions')
  async process(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: ProcessWagerTransactionDto,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: StatusResponse
  ) {
    const command: ProcessWagerTransactionCommand = {
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      idempotencyKey: idempotencyKey ?? '',
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      money: body.money,
      referenceExternalTransactionId: body.referenceExternalTransactionId,
      correlationId
    };
    const result = await this.processTransaction.execute(command);
    response.status(this.httpStatusFor(result));

    if (
      result.status === WagerTransactionStatus.Rejected ||
      result.status === WagerTransactionStatus.Failed
    ) {
      const rejected: RejectedResponse = {
        failureCode: result.failureCode,
        message:
          result.status === WagerTransactionStatus.Failed
            ? 'Transaction failed after persistence'
            : 'Transaction rejected by a business rule',
        correlationId,
        transactionId: result.transactionId,
        status: result.status,
        idempotentReplay: result.idempotentReplay
      };
      return rejected;
    }

    return result;
  }

  @Get('wagering/transactions/:transactionId')
  byId(@Param('transactionId', new ParseUUIDPipe()) transactionId: string) {
    return this.getTransaction.byId(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byProviderExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string
  ) {
    return this.getTransaction.byProviderExternalId(providerId, externalTransactionId);
  }

  private httpStatusFor(result: ProcessWagerTransactionResult): number {
    switch (result.status) {
      case WagerTransactionStatus.Processed:
        return result.idempotentReplay ? HttpStatus.OK : HttpStatus.CREATED;
      case WagerTransactionStatus.PendingReference:
      case WagerTransactionStatus.Pending:
        return HttpStatus.ACCEPTED;
      case WagerTransactionStatus.Rejected:
        return HttpStatus.UNPROCESSABLE_ENTITY;
      case WagerTransactionStatus.Failed:
        return HttpStatus.INTERNAL_SERVER_ERROR;
    }
  }
}
