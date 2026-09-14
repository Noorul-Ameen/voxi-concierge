import { DomainError, ErrorCodes } from "@voxi/contracts";

/** A cheaper exchange needs an explicitly selected, reviewed destination. */
export function assertSwapRefundSelection(summary: Record<string, any>) {
  if (
    Number(summary.differenceCents) < 0 &&
    (summary.refundMethodSelected !== true ||
      !["ORIGINAL_PAYMENT", "VOX_CREDIT", "SHARE_POINTS"].includes(summary.refundMethod) ||
      !Array.isArray(summary.permittedRefundMethods) ||
      !summary.permittedRefundMethods.includes(summary.refundMethod))
  )
    throw new DomainError(
      ErrorCodes.CONFIRMATION_REQUIRED,
      "Choose a permitted refund destination and review the exchange again before confirming.",
    );
}
