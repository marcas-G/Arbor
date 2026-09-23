/**
 * P13 `02` §3 rule 2: client-side UUIDv7 (RFC 9562) for `cmd_<uuid-v7>`
 * command ids. Canonical 8-4-4-4-12 text layout: 48-bit unix-ms timestamp
 * prefix, version 7, variant 10xx.
 */

export function uuidv7(): string {
  const timestampHex = Date.now().toString(16).padStart(12, "0");
  const randomHex = Array.from(
    crypto.getRandomValues(new Uint8Array(10)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const variantNibble = (
    8 |
    (Number.parseInt(randomHex.slice(3, 4), 16) & 0x03)
  ).toString(16);
  return [
    timestampHex.slice(0, 8),
    timestampHex.slice(8, 12),
    `7${randomHex.slice(0, 3)}`,
    `${variantNibble}${randomHex.slice(4, 7)}`,
    randomHex.slice(7, 19),
  ].join("-");
}
