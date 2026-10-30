import { Inject, Injectable } from '@nestjs/common';
import { FailureCode } from '../../shared/errors/failure-code';
import { ResourceNotFoundError } from '../errors/application.errors';
import { WALLET_REPOSITORY } from '../ports/tokens';
import type { WalletRepository } from '../ports/wallet.repository';
import type { WalletView } from './query.types';

@Injectable()
export class GetWalletUseCase {
  constructor(@Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.wallets.findById(walletId);
    if (wallet === undefined) {
      throw new ResourceNotFoundError('Wallet not found', FailureCode.WalletNotFound);
    }
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version
    };
  }
}
