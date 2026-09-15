/**
 * Delivery markers the model may emit so the speech engine can colour a line ("[excited]", "[laughs]").
 * They control voice only: they must never appear in the visible transcript, and they are stripped from
 * displayed text rather than from what is sent to the speech engine.
 */
const DELIVERY_TAGS = new Set([
  "angry", "apologetic", "calm", "cheerful", "chuckles", "crying", "curious", "disappointed",
  "emphatic", "empathetic", "enthusiastic", "excited", "friendly", "gasp", "gasps", "giggles",
  "happy", "hesitant", "laugh", "laughing", "laughs", "laughter", "long pause", "nervous",
  "neutral", "pause", "playful", "quickly", "reassuring", "sad", "sarcastic", "serious",
  "short pause", "sigh", "sighs", "slowly", "smiles", "smiling", "softly", "surprised",
  "thoughtful", "upbeat", "warm", "whispering", "whispers",
  "حزين", "سعيد", "متحمس", "ضحك", "ابتسامة", "همس",
]);

/** Remove delivery markers from text shown to the guest, leaving every other bracketed value intact. */
export function stripDeliveryTags(text: string): string {
  if (!text.includes("[")) return text;
  return text
    .replace(/\[([^\]\n]{1,30})\]/g, (match, inner: string) =>
      DELIVERY_TAGS.has(inner.trim().toLowerCase()) ? "" : match,
    )
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.!?؟،])/g, "$1")
    .trim();
}
