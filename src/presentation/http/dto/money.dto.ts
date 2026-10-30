import { IsString, Length, Matches } from 'class-validator';

const MONEY_AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

export class MoneyDto {
  @IsString()
  @Matches(MONEY_AMOUNT_PATTERN, {
    message: 'amount must be a non-negative decimal with at most 2 fractional digits'
  })
  amount!: string;

  @IsString()
  @Length(3, 3)
  currency!: string;
}
