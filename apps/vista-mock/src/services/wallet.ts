import { type Db, schema as S, shortId } from "@voxi/db";
import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Caller keeps the account row locked until its enclosing payment/refund transaction ends. */
export async function expireWalletCredits(tx: Tx, memberId: string, now = new Date()) {
  const [account] = await tx
    .select()
    .from(S.loyaltyAccounts)
    .where(eq(S.loyaltyAccounts.memberId, memberId))
    .for("update");
  if (!account) return null;
  const lots = await tx
    .select()
    .from(S.loyaltyLedger)
    .where(
      and(
        eq(S.loyaltyLedger.memberId, memberId),
        eq(S.loyaltyLedger.balanceType, "VOX_REWARDS"),
        gt(S.loyaltyLedger.remainingValueCents, 0),
        isNotNull(S.loyaltyLedger.expiresAt),
      ),
    );
  let expired = 0;
  for (const lot of lots)
    if (lot.expiresAt! <= now) {
      expired += lot.remainingValueCents!;
      await tx.update(S.loyaltyLedger).set({ remainingValueCents: 0 }).where(eq(S.loyaltyLedger.id, lot.id));
    }
  if (!expired) return account;
  const deduction = Math.min(expired, account.voxRewardsBalanceCents);
  const [updated] = await tx
    .update(S.loyaltyAccounts)
    .set({
      voxRewardsBalanceCents: account.voxRewardsBalanceCents - deduction,
      version: account.version + 1,
      updatedAt: now,
    })
    .where(eq(S.loyaltyAccounts.memberId, memberId))
    .returning();
  await tx.insert(S.loyaltyLedger).values({
    id: shortId(12),
    memberId,
    balanceType: "VOX_REWARDS",
    delta: -deduction,
    reason: "Unused refund credit expired after 90 days",
    reference: `expiry_${shortId(10)}`,
  });
  return updated!;
}

/** Spend the soonest-expiring credits first; the caller separately debits the account exactly once. */
export async function consumeWalletCredits(tx: Tx, memberId: string, amountCents: number) {
  const lots = await tx
    .select()
    .from(S.loyaltyLedger)
    .where(
      and(
        eq(S.loyaltyLedger.memberId, memberId),
        eq(S.loyaltyLedger.balanceType, "VOX_REWARDS"),
        gt(S.loyaltyLedger.remainingValueCents, 0),
      ),
    )
    .orderBy(asc(S.loyaltyLedger.expiresAt), asc(S.loyaltyLedger.createdAt));
  let remaining = amountCents;
  for (const lot of lots) {
    if (!remaining) break;
    const used = Math.min(remaining, lot.remainingValueCents!);
    remaining -= used;
    await tx
      .update(S.loyaltyLedger)
      .set({ remainingValueCents: sql`${S.loyaltyLedger.remainingValueCents} - ${used}` })
      .where(eq(S.loyaltyLedger.id, lot.id));
  }
}

export const refundCreditExpiry = (now = new Date()) => new Date(now.getTime() + 90 * 24 * 60 * 60_000);
