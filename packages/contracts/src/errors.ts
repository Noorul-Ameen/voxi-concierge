/** Domain error codes the agent can narrate. Keep stable — prompts reference them. */
export const ErrorCodes = {
  NOT_FOUND: "NOT_FOUND",
  VALIDATION: "VALIDATION",
  BOOKING_NOT_FOUND: "BOOKING_NOT_FOUND",
  BOOKING_ALREADY_CANCELLED: "BOOKING_ALREADY_CANCELLED",
  BOOKING_NOT_ELIGIBLE: "BOOKING_NOT_ELIGIBLE",
  CUTOFF_PASSED: "CUTOFF_PASSED",
  TICKETS_USED: "TICKETS_USED",
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
  CONFIRMATION_EXPIRED: "CONFIRMATION_EXPIRED",
  CONFLICT: "CONFLICT",
  SEATS_UNAVAILABLE: "SEATS_UNAVAILABLE",
  ORDER_EXPIRED: "ORDER_EXPIRED",
  ORDER_INVALID_STATE: "ORDER_INVALID_STATE",
  OFFER_NOT_ELIGIBLE: "OFFER_NOT_ELIGIBLE",
  LOCATION_REQUIRED: "LOCATION_REQUIRED",
  INSUFFICIENT_POINTS: "INSUFFICIENT_POINTS",
  PAYMENT_DECLINED: "PAYMENT_DECLINED",
  LOGIN_REQUIRED: "LOGIN_REQUIRED",
  VISTA_ERROR: "VISTA_ERROR",
  VISTA_UNAVAILABLE: "VISTA_UNAVAILABLE",
  HANDOVER_FAILED: "HANDOVER_FAILED",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL: "INTERNAL",
} as const;
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }
  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable, detail: this.detail };
  }
}
