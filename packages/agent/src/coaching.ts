/** Offline coaching flags. This never adds another model call or rewrites a live response. */
export type CoachingInput = {
  text: string;
  modality: "voice" | "text";
  previousResponses?: string[];
  known?: Partial<Record<"movie" | "cinema" | "date" | "quantity" | "language", boolean>>;
  confirmedFacts?: { amountsCents?: number[]; bookingReferences?: string[] };
};
export type CoachingFlag =
  | "formal_tone"
  | "too_long"
  | "multiple_questions"
  | "repeated_response"
  | "asks_known_information"
  | "unsupported_amount"
  | "unsupported_booking_reference";
const normalise = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function assessResponse(input: CoachingInput): { flags: CoachingFlag[]; needsReview: boolean } {
  const flags: CoachingFlag[] = [];
  const { text } = input;
  if (
    /\b(certainly|kindly|please be advised|i would be happy to assist|would you like me to proceed|based on your preferences|your selection has been confirmed)\b/i.test(
      text,
    )
  )
    flags.push("formal_tone");
  if (text.trim().split(/\s+/).length > (input.modality === "voice" ? 42 : 70)) flags.push("too_long");
  if ((text.match(/[?؟]/g) ?? []).length > 1) flags.push("multiple_questions");
  if (input.previousResponses?.slice(-3).some((previous) => normalise(previous) === normalise(text)))
    flags.push("repeated_response");
  const questions = {
    movie: /(?:which|what) (?:movie|film).*[?؟]/i,
    cinema: /(?:which|what) (?:cinema|location).*[?؟]/i,
    date: /(?:which|what) (?:day|date).*[?؟]/i,
    quantity: /how many (?:tickets|people|are going).*[?؟]/i,
    language: /(?:which|what) (?:movie )?language.*[?؟]/i,
  };
  if (
    Object.entries(questions).some(
      ([field, pattern]) => input.known?.[field as keyof typeof questions] && pattern.test(text),
    )
  )
    flags.push("asks_known_information");
  if (input.confirmedFacts?.amountsCents) {
    const amounts = [
      ...text.matchAll(/(?:AED\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*dirhams?)/gi),
    ].map((match) => Math.round(Number((match[1] ?? match[2])!.replace(/,/g, "")) * 100));
    if (amounts.some((amount) => !input.confirmedFacts!.amountsCents!.includes(amount)))
      flags.push("unsupported_amount");
  }
  if (input.confirmedFacts?.bookingReferences) {
    const references = [...text.matchAll(/\bW[A-Z0-9]{6}\b/g)].map((match) => match[0]);
    if (references.some((ref) => !input.confirmedFacts!.bookingReferences!.includes(ref)))
      flags.push("unsupported_booking_reference");
  }
  return { flags, needsReview: flags.length > 0 };
}
