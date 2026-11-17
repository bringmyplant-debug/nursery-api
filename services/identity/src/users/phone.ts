/**
 * Indian mobile numbers only, as E.164 (`+91` and ten digits).
 *
 * A deliberate restriction, not a missing feature: the product is India-only,
 * and accepting arbitrary international numbers is how an OTP endpoint turns
 * into an SMS-pumping fraud vector (attackers trigger messages to premium
 * routes abroad). Widening it is a conscious decision made here.
 *
 * Accepts what people actually type: spaces, dashes and brackets are
 * ignored, and `+91`, `91` and a leading `0` are accepted as prefixes.
 * Indian mobile numbers start 6-9.
 */
export function normalizeIndianMobile(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 24) return null;

  const stripped = input.replace(/[\s\-().]/g, "");
  if (!/^\+?\d+$/.test(stripped)) return null;

  let digits = stripped.startsWith("+") ? stripped.slice(1) : stripped;
  if (stripped.startsWith("+") && !digits.startsWith("91")) return null;

  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);

  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

/** `+91 ••••• ••210`: enough for a person to recognise their own number in a log, not to call it. */
export function maskPhone(phone: string): string {
  return phone.length > 4 ? `${phone.slice(0, 3)}${"•".repeat(Math.max(0, phone.length - 6))}${phone.slice(-3)}` : "•••";
}
