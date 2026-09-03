import { randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to keep booking ids readable when spoken
export function shortId(len = 7): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}
export function prefixedId(prefix: string, len = 12): string {
  return `${prefix}_${randomBytes(len).toString("base64url").slice(0, len)}`;
}
