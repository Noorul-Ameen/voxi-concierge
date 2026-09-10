import { scrypt as deriveKey, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(deriveKey);
const KEY_BYTES = 64;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8 || password.length > 256)
    throw new Error("Demo account passwords must have 8–256 characters");
  const salt = randomBytes(16).toString("hex");
  const key = (await scrypt(password, salt, KEY_BYTES)) as Buffer;
  return `scrypt$${salt}$${key.toString("hex")}`;
}

export async function verifyPassword(
  password: unknown,
  encoded: string | null | undefined,
): Promise<boolean> {
  if (typeof password !== "string" || !password || password.length > 256) return false;
  const [kind, salt, expectedHex, extra] = (encoded ?? "").split("$");
  // Missing-account attempts still do the same expensive work, without accepting any password.
  const valid =
    kind === "scrypt" &&
    /^[a-f0-9]{32}$/.test(salt ?? "") &&
    /^[a-f0-9]{128}$/.test(expectedHex ?? "") &&
    !extra;
  const key = (await scrypt(
    password,
    valid ? salt! : "00000000000000000000000000000000",
    KEY_BYTES,
  )) as Buffer;
  return valid && timingSafeEqual(key, Buffer.from(expectedHex!, "hex"));
}
