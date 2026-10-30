import { Type } from 'class-transformer';
import {
  IsDefined,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested
} from 'class-validator';
import { WagerTransactionKind } from '../../../domain/wager-transaction/wager-transaction-kind';
import { MoneyDto } from './money.dto';

export class ProcessWagerTransactionDto {
  @IsString()
  @Length(1, 255)
  providerId!: string;

  @IsString()
  @Length(1, 255)
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  @Length(1, 255)
  roundId!: string;

  @IsString()
  @Length(1, 255)
  gameId!: string;

  @IsEnum(WagerTransactionKind)
  kind!: WagerTransactionKind;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  @Length(1, 255)
  referenceExternalTransactionId?: string;
}
