/**
 * Prints the latest sign-in code sent to a phone number (development only).
 *
 *   npm run otp -- 9000000001
 *
 * Works in any shell (PowerShell's `curl` is an alias that rejects -H, which
 * is why the raw curl command fails there). Asks the identity service's
 * dev-only endpoint, which exists only while SMS_PROVIDER=console.
 */
const phone = process.argv[2];
if (!phone) {
  console.error("Usage: npm run otp -- <10-digit number>   e.g. npm run otp -- 9000000001");
  process.exit(1);
}

const base = process.env.IDENTITY_URL ?? "http://localhost:4104";
const token = process.env.INTERNAL_API_TOKEN ?? "dev-internal-token-change-me";

fetch(`${base}/internal/dev/otp/${encodeURIComponent(phone)}`, { headers: { "x-internal-token": token } })
  .then(async (res) => {
    if (res.status === 404) {
      console.error("No code yet for that number. Click 'Send code' on the sign-in page first (codes last 5 minutes).");
      process.exit(2);
    }
    if (res.status === 401) {
      console.error("Rejected: INTERNAL_API_TOKEN does not match the identity service's.");
      process.exit(3);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { code } = await res.json();
    console.log(code);
  })
  .catch((error) => {
    console.error(`Could not reach the identity service at ${base}: ${error.message}. Is it running?`);
    process.exit(4);
  });
