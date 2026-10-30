import { WalletLedgerEntry } from '../../../domain/ledger/wallet-ledger-entry';
import { Money } from '../../../domain/money/money';
import { WalletLedgerEntryEntity } from '../entities/wallet-ledger-entry.entity';

export class WalletLedgerEntryMapper {
  static toDomain(entity: WalletLedgerEntryEntity): WalletLedgerEntry {
    const currency = entity.currency;
    return WalletLedgerEntry.rehydrate({
      id: entity.id,
      walletId: entity.walletId,
      transactionId: entity.transactionId,
      direction: entity.direction,
      money: Money.from({ amount: String(entity.amount), currency }),
      balanceBefore: Money.from({
        amount: String(entity.balanceBeforeAmount),
        currency
      }),
      balanceAfter: Money.from({ amount: String(entity.balanceAfterAmount), currency }),
      walletVersion: entity.walletVersion,
      createdAt: entity.createdAt
    });
  }

  static toEntity(
    entry: WalletLedgerEntry,
    entity: WalletLedgerEntryEntity = new WalletLedgerEntryEntity()
  ): WalletLedgerEntryEntity {
    entity.id = entry.id;
    entity.walletId = entry.walletId;
    entity.transactionId = entry.transactionId;
    entity.walletVersion = entry.walletVersion;
    entity.direction = entry.direction;
    entity.amount = entry.money.toString();
    entity.currency = entry.money.currency;
    entity.balanceBeforeAmount = entry.balanceBefore.toString();
    entity.balanceAfterAmount = entry.balanceAfter.toString();
    entity.createdAt = entry.createdAt;
    return entity;
  }
}
