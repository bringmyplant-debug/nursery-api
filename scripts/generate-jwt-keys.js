/**
 * Generates the ES256 key pair that signs and verifies access tokens.
 *
 *   node scripts/generate-jwt-keys.js           # creates .keys/ if absent
 *   node scripts/generate-jwt-keys.js --force   # replaces them (signs everyone out)
 *
 * Only the identity service gets the private key. Every other service gets
 * the public key, so a compromised catalogue can verify tokens but never
 * mint one. Keys are written outside any package, git-ignored, and the
 * private one is created owner-readable only.
 */
const { generateKeyPairSync } = require("node:crypto");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const dir = join(__dirname, "..", ".keys");
const privatePath = join(dir, "jwt-private.pem");
const publicPath = join(dir, "jwt-public.pem");

if (existsSync(privatePath) && !process.argv.includes("--force")) {
  console.log(`Keys already exist in ${dir}; leaving them alone (use --force to replace).`);
  process.exit(0);
}

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

mkdirSync(dir, { recursive: true });
writeFileSync(privatePath, privateKey, { mode: 0o600 });
writeFileSync(publicPath, publicKey, { mode: 0o644 });
console.log(`Wrote ${privatePath} and ${publicPath}`);
