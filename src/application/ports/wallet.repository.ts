import { Wallet } from '../../domain/wallet/wallet';
import { TransactionContext } from './transaction-context';

export interface WalletRepository {
  findById(id: string, ctx?: TransactionContext): Promise<Wallet | undefined>;
  findByIdWithLock(id: string, ctx?: TransactionContext): Promise<Wallet | undefined>;
  save(wallet: Wallet, ctx?: TransactionContext): Promise<void>;
}
