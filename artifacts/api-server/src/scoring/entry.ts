/** A pass still needs a tracked-wallet buy. Public tape can only suggest. */
export function canLockPass(walletBuys: number): boolean {
  return Number(walletBuys) >= 1;
}
