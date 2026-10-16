import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

// How a password is kept: a scrypt key from it and a random salt, never the password. The local owner's credential file and
// the team accounts use the same shape, so the owner's saved verifier can become their team account unchanged.
const derive = promisify(scrypt);
export const PASSWORD_KDF = Object.freeze({ algorithm: "scrypt", cost: 131072, blockSize: 8, parallelization: 1, keyLength: 32 });
const VERIFIER_KEYS = [...Object.keys(PASSWORD_KDF), "salt", "derivedKey"];

export function isPasswordVerifier(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === VERIFIER_KEYS.length &&
    VERIFIER_KEYS.every(key => Object.hasOwn(value, key)) && Object.entries(PASSWORD_KDF).every(([key, setting]) => value[key] === setting) &&
    typeof value.salt === "string" && /^[a-f0-9]{32}$/u.test(value.salt) &&
    typeof value.derivedKey === "string" && /^[a-f0-9]{64}$/u.test(value.derivedKey);
}

/** The scrypt key for `password` and a hex salt. Callers zero it when done. */
export function derivePasswordKey(password, salt) {
  return derive(password, Buffer.from(salt, "hex"), PASSWORD_KDF.keyLength,
    { N: PASSWORD_KDF.cost, r: PASSWORD_KDF.blockSize, p: PASSWORD_KDF.parallelization, maxmem: 192 * 1024 * 1024 });
}

export async function createPasswordVerifier(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await derivePasswordKey(password, salt);
  const verifier = { ...PASSWORD_KDF, salt, derivedKey: key.toString("hex") };
  key.fill(0);
  return verifier;
}

export async function passwordMatches(password, verifier) {
  const key = await derivePasswordKey(password, verifier.salt);
  const matches = timingSafeEqual(key, Buffer.from(verifier.derivedKey, "hex"));
  key.fill(0);
  return matches;
}
