/**
 * Integration tests: the real services against a real Postgres.
 *
 * Auth is where mocked tests flatter you, because the guarantees that
 * matter (a code works once, guesses are capped, a session is rotated
 * exactly once even when two requests race) live in conditional SQL and
 * transactions. So these run the actual statements.
 *
 * They use the `_shadow` twin of the identity database, which exists for
 * Prisma's own scratch use and holds nothing precious, and they refuse to
 * run against anything else (they truncate tables). If the database is not
 * reachable or not migrated they skip, so `npm test` still works without
 * Docker. Prepare it with:
 *
 *   DATABASE_URL=<shadow url> npx prisma migrate deploy
 */
import { generateKeyPairSync } from "node:crypto";
import { createPgAdapter, verifyAccessToken } from "@nursery-co/platform";
import { PrismaClient } from "../generated/prisma";
import type { IdentitySettings } from "../config/settings";
import { OtpService } from "../otp/otp.service";
import type { SmsProvider } from "../otp/sms.provider";
import { TokenService, hashRefreshToken } from "../tokens/token.service";
import { AuthError } from "./auth-error";
import { AuthService } from "./auth.service";

const URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://svc_identity:identity_dev@localhost:5434/nursery_identity_shadow?schema=public";

if (!/_(shadow|test)\b/.test(URL.split("?")[0])) {
  throw new Error(`Refusing to run destructive integration tests against ${URL.split("@").pop()}`);
}

const prisma = new PrismaClient({ adapter: createPgAdapter(URL, 5) });

const probe = prisma.user
  .count()
  .then(() => true)
  .catch(() => false);

const keys = generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const settings: IdentitySettings = {
  privateKey: keys.privateKey,
  publicKey: keys.publicKey,
  accessTokenTtlSeconds: 900,
  refreshTokenTtlDays: 30,
  refreshReuseGraceSeconds: 10,
  otpLength: 6,
  otpTtlSeconds: 300,
  otpMaxAttempts: 5,
  otpResendSeconds: 30,
  otpMaxPerPhonePerHour: 5,
  otpPepper: "test-pepper-0123456789-0123456789-xyz",
  signupTokenTtlSeconds: 600,
};

const PHONE = "+919876543210";
const PHONE_INPUT = "98765 43210";
const OTHER_PHONE = "+919123456789";

/** Captures every code "sent", and can be made to fail. */
class FakeSms implements SmsProvider {
  sent: { phone: string; code: string }[] = [];
  failNext = false;

  async sendOtp(phone: string, code: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("carrier down");
    }
    this.sent.push({ phone, code });
  }

  last(phone = PHONE): string {
    const hit = [...this.sent].reverse().find((s) => s.phone === phone);
    if (!hit) throw new Error(`no code sent to ${phone}`);
    return hit.code;
  }
}

const errorCode = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AuthError) return error.code;
    throw error;
  }
  return "no-error";
};

describe("identity: against Postgres", () => {
  let available = false;
  let nowMs = Date.parse("2026-11-15T10:00:00Z");
  const clock = () => new Date(nowMs);
  const advance = (seconds: number) => {
    nowMs += seconds * 1000;
  };

  let sms: FakeSms;
  let otp: OtpService;
  let tokens: TokenService;
  let auth: AuthService;

  beforeAll(async () => {
    available = await probe;
    // Fail loudly if the schema is stale rather than skipping, once we know there is a database.
    if (available) await prisma.otpChallenge.count();
  });

  beforeEach(async (ctx) => {
    // No database (no Docker, or not migrated): skip rather than fail, so npm test works anywhere.
    if (!available) ctx.skip();
    await prisma.$executeRawUnsafe("TRUNCATE users, otp_challenges, refresh_tokens CASCADE");
    nowMs = Date.parse("2026-11-15T10:00:00Z");
    sms = new FakeSms();
    otp = new OtpService(prisma, sms, settings, clock);
    tokens = new TokenService(prisma, settings, clock);
    auth = new AuthService(prisma, otp, tokens, settings, clock);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Sign a number up from scratch and return the session. */
  async function signUp(phone = PHONE, name = "Asha Rao", email?: string) {
    await auth.requestOtp(phone);
    const verified = await auth.verifyOtp(phone, sms.last(phone));
    if (verified.status !== "profile_required") throw new Error("expected a new number");
    return auth.completeSignup({ signupToken: verified.signupToken, name, email, acceptTerms: true });
  }

  /** Sign in an existing account and return the session. */
  async function signIn(phone = PHONE) {
    advance(31);
    await auth.requestOtp(phone);
    const verified = await auth.verifyOtp(phone, sms.last(phone));
    if (verified.status !== "signed_in") throw new Error("expected an existing account");
    return verified;
  }

  describe("one-time codes", () => {
    it("stores a keyed hash, never the code", async () => {
      await auth.requestOtp(PHONE_INPUT);
      const [row] = await prisma.otpChallenge.findMany();
      expect(row.phone).toBe(PHONE);
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.codeHash).not.toContain(sms.last());
      expect(sms.last()).toMatch(/^\d{6}$/);
    });

    it("answers a request identically for a registered and an unregistered number", async () => {
      await signUp(PHONE);
      advance(31);
      const registered = await auth.requestOtp(PHONE);
      const unregistered = await auth.requestOtp(OTHER_PHONE);
      expect(registered).toEqual(unregistered);
    });

    it("rejects a malformed phone before touching the database or the carrier", async () => {
      expect(await errorCode(auth.requestOtp("12345"))).toBe("invalid_phone");
      expect(await errorCode(auth.requestOtp("+14155552671"))).toBe("invalid_phone");
      expect(sms.sent).toHaveLength(0);
      expect(await prisma.otpChallenge.count()).toBe(0);
    });

    it("enforces a cooldown between codes, and reports how long to wait", async () => {
      await auth.requestOtp(PHONE);
      advance(10);
      try {
        await auth.requestOtp(PHONE);
        throw new Error("should have been refused");
      } catch (error) {
        expect(error).toBeInstanceOf(AuthError);
        expect((error as AuthError).code).toBe("too_many_requests");
        expect((error as AuthError).getResponse()).toMatchObject({ retryAfterSeconds: 20 });
      }
      advance(21);
      await expect(auth.requestOtp(PHONE)).resolves.toBeDefined();
    });

    it("caps codes per phone per hour", async () => {
      for (let i = 0; i < 5; i++) {
        await auth.requestOtp(PHONE);
        advance(31);
      }
      expect(await errorCode(auth.requestOtp(PHONE))).toBe("too_many_requests");
      advance(3600);
      await expect(auth.requestOtp(PHONE)).resolves.toBeDefined();
    });

    it("kills the previous code when a new one is requested", async () => {
      await auth.requestOtp(PHONE);
      const first = sms.last();
      advance(31);
      await auth.requestOtp(PHONE);
      const second = sms.last();

      // Guard against the (1 in a million) chance the two codes collide.
      if (first !== second) {
        expect(await errorCode(auth.verifyOtp(PHONE, first))).toBe("invalid_code");
      }
      expect((await auth.verifyOtp(PHONE, second)).status).toBe("profile_required");
    });

    it("accepts a correct code once and only once", async () => {
      await auth.requestOtp(PHONE);
      const code = sms.last();
      await auth.verifyOtp(PHONE, code);
      expect(await errorCode(auth.verifyOtp(PHONE, code))).toBe("invalid_code");
    });

    it("lets exactly one of two simultaneous correct submissions win", async () => {
      await auth.requestOtp(PHONE);
      const code = sms.last();
      const results = await Promise.allSettled([auth.verifyOtp(PHONE, code), auth.verifyOtp(PHONE, code)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    });

    it("rejects an expired code", async () => {
      await auth.requestOtp(PHONE);
      const code = sms.last();
      advance(301);
      expect(await errorCode(auth.verifyOtp(PHONE, code))).toBe("invalid_code");
    });

    it("locks after the allowed wrong guesses, even against the right code", async () => {
      await auth.requestOtp(PHONE);
      const right = sms.last();
      const wrong = right === "000000" ? "111111" : "000000";

      for (let i = 0; i < 5; i++) expect(await errorCode(auth.verifyOtp(PHONE, wrong))).toBe("invalid_code");
      expect(await errorCode(auth.verifyOtp(PHONE, right))).toBe("too_many_attempts");
      expect(await errorCode(auth.verifyOtp(PHONE, wrong))).toBe("too_many_attempts");

      // Recovery is a fresh code, not waiting.
      advance(31);
      await auth.requestOtp(PHONE);
      expect((await auth.verifyOtp(PHONE, sms.last())).status).toBe("profile_required");
    });

    it("still accepts the right code on the last allowed attempt", async () => {
      await auth.requestOtp(PHONE);
      const right = sms.last();
      const wrong = right === "000000" ? "111111" : "000000";
      for (let i = 0; i < 4; i++) await errorCode(auth.verifyOtp(PHONE, wrong));
      expect((await auth.verifyOtp(PHONE, right)).status).toBe("profile_required");
    });

    it("counts guesses made in parallel, so a burst cannot beat the limit", async () => {
      await auth.requestOtp(PHONE);
      const right = sms.last();
      const wrong = right === "000000" ? "111111" : "000000";
      await Promise.allSettled(Array.from({ length: 12 }, () => auth.verifyOtp(PHONE, wrong)));
      const [row] = await prisma.otpChallenge.findMany();
      expect(row.attempts).toBe(5);
    });

    it("does not spend an attempt on a code of the wrong shape", async () => {
      await auth.requestOtp(PHONE);
      expect(await errorCode(auth.verifyOtp(PHONE, "12ab56"))).toBe("invalid_code");
      expect(await errorCode(auth.verifyOtp(PHONE, "123"))).toBe("invalid_code");
      const [row] = await prisma.otpChallenge.findMany();
      expect(row.attempts).toBe(0);
    });

    it("leaves no live code behind when the carrier fails, and does not make the user wait", async () => {
      sms.failNext = true;
      expect(await errorCode(auth.requestOtp(PHONE))).toBe("sms_unavailable");
      expect(await prisma.otpChallenge.count()).toBe(0);
      await expect(auth.requestOtp(PHONE)).resolves.toBeDefined();
    });

    it("fails for a number that never asked for a code", async () => {
      expect(await errorCode(auth.verifyOtp(OTHER_PHONE, "123456"))).toBe("invalid_code");
    });
  });

  describe("sign-up", () => {
    it("tells a new number to complete a profile, and creates nothing yet", async () => {
      await auth.requestOtp(PHONE);
      const result = await auth.verifyOtp(PHONE, sms.last());
      expect(result.status).toBe("profile_required");
      expect(await prisma.user.count()).toBe(0);
    });

    it("creates a buyer and signs them in", async () => {
      const { user, tokens: t } = await signUp(PHONE, "Asha Rao", "asha@example.com");
      expect(user).toMatchObject({ phone: PHONE, name: "Asha Rao", email: "asha@example.com", role: "BUYER" });

      const claims = verifyAccessToken(keys.publicKey, t.accessToken);
      expect(claims).toMatchObject({ sub: user.id, role: "BUYER" });

      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(row.phoneVerifiedAt).toBeInstanceOf(Date);
      expect(row.termsAcceptedAt).toBeInstanceOf(Date);
    });

    it("works without an email", async () => {
      const { user } = await signUp();
      expect(user.email).toBeNull();
    });

    it("cannot be completed twice with the same verification", async () => {
      await auth.requestOtp(PHONE);
      const verified = await auth.verifyOtp(PHONE, sms.last());
      if (verified.status !== "profile_required") throw new Error("setup");
      const input = { signupToken: verified.signupToken, name: "Asha Rao", acceptTerms: true as const };

      await auth.completeSignup(input);
      expect(await errorCode(auth.completeSignup(input))).toBe("already_registered");
      expect(await prisma.user.count()).toBe(1);
    });

    it("refuses an email that is already taken", async () => {
      await signUp(PHONE, "Asha Rao", "same@example.com");
      advance(31);
      await auth.requestOtp(OTHER_PHONE);
      const verified = await auth.verifyOtp(OTHER_PHONE, sms.last(OTHER_PHONE));
      if (verified.status !== "profile_required") throw new Error("setup");
      expect(
        await errorCode(
          auth.completeSignup({ signupToken: verified.signupToken, name: "Ravi", email: "same@example.com", acceptTerms: true }),
        ),
      ).toBe("email_taken");
    });

    it("rejects a forged, malformed or expired verification token", async () => {
      expect(await errorCode(auth.completeSignup({ signupToken: "nonsense", name: "Asha Rao", acceptTerms: true }))).toBe(
        "invalid_signup_token",
      );

      await auth.requestOtp(PHONE);
      const verified = await auth.verifyOtp(PHONE, sms.last());
      if (verified.status !== "profile_required") throw new Error("setup");
      // Alter the payload, not the signature: the last base64url character of a
      // signature carries unused padding bits, so changing it can leave the bytes (and the signature) intact.
      const [h, p, s] = verified.signupToken.split(".");
      const mid = Math.floor(p.length / 2);
      const tampered = `${h}.${p.slice(0, mid)}${p[mid] === "A" ? "B" : "A"}${p.slice(mid + 1)}.${s}`;
      expect(await errorCode(auth.completeSignup({ signupToken: tampered, name: "Asha Rao", acceptTerms: true }))).toBe(
        "invalid_signup_token",
      );
    });

    it("rejects an access token presented as a verification token", async () => {
      const { tokens: t } = await signUp();
      expect(await errorCode(auth.completeSignup({ signupToken: t.accessToken, name: "Mallory", acceptTerms: true }))).toBe(
        "invalid_signup_token",
      );
    });

    it("always creates a buyer, whatever the caller tries", async () => {
      await auth.requestOtp(PHONE);
      const verified = await auth.verifyOtp(PHONE, sms.last());
      if (verified.status !== "profile_required") throw new Error("setup");
      const hostile = { signupToken: verified.signupToken, name: "Mallory", acceptTerms: true as const, role: "ADMIN" };
      const { user } = await auth.completeSignup(hostile as never);
      expect(user.role).toBe("BUYER");
    });
  });

  describe("sign-in", () => {
    it("signs an existing account in with a fresh session", async () => {
      const first = await signUp();
      const result = await signIn();
      expect(result.user.id).toBe(first.user.id);
      expect(result.tokens.refreshToken).not.toBe(first.tokens.refreshToken);
      expect(verifyAccessToken(keys.publicKey, result.tokens.accessToken).sub).toBe(first.user.id);
    });

    it("records the login time", async () => {
      const { user } = await signUp();
      advance(3600);
      await signIn();
      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      // signIn() ran at the current clock reading, an hour after sign-up.
      expect(row.lastLoginAt!.getTime()).toBe(nowMs);
    });

    it("refuses a suspended account, after the owner proves the number", async () => {
      const { user } = await signUp();
      await prisma.user.update({ where: { id: user.id }, data: { status: "SUSPENDED" } });
      advance(31);
      await auth.requestOtp(PHONE);
      expect(await errorCode(auth.verifyOtp(PHONE, sms.last()))).toBe("account_suspended");
    });

    it("keeps two devices as two independent sessions", async () => {
      await signUp();
      const a = await signIn();
      const b = await signIn();
      await auth.logout(a.tokens.refreshToken);
      await expect(auth.refresh(b.tokens.refreshToken)).resolves.toBeDefined();
    });
  });

  describe("sessions", () => {
    it("never stores a refresh token, only its hash", async () => {
      const { tokens: t } = await signUp();
      const rows = await prisma.refreshToken.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0].tokenHash).toBe(hashRefreshToken(t.refreshToken));
      expect(JSON.stringify(rows)).not.toContain(t.refreshToken);
    });

    it("rotates: the old token is spent, a new pair is issued, the family is kept", async () => {
      const first = await signUp();
      const next = await auth.refresh(first.tokens.refreshToken);

      expect(next.tokens.refreshToken).not.toBe(first.tokens.refreshToken);
      expect(next.user.id).toBe(first.user.id);
      const rows = await prisma.refreshToken.findMany({ orderBy: { createdAt: "asc" } });
      expect(rows).toHaveLength(2);
      expect(rows[0].familyId).toBe(rows[1].familyId);
      expect(rows[0].rotatedAt).not.toBeNull();
      expect(rows[0].replacedById).toBe(rows[1].id);
    });

    it("keeps the same session id across rotations", async () => {
      const first = await signUp();
      const next = await auth.refresh(first.tokens.refreshToken);
      expect(verifyAccessToken(keys.publicKey, next.tokens.accessToken).sid).toBe(
        verifyAccessToken(keys.publicKey, first.tokens.accessToken).sid,
      );
    });

    it("treats a just-used token as a concurrent request: refused, but the session survives", async () => {
      const first = await signUp();
      const next = await auth.refresh(first.tokens.refreshToken);

      advance(3);
      expect(await errorCode(auth.refresh(first.tokens.refreshToken))).toBe("refresh_in_flight");
      await expect(auth.refresh(next.tokens.refreshToken)).resolves.toBeDefined();
    });

    it("treats a long-spent token as theft and ends the whole session", async () => {
      const first = await signUp();
      const next = await auth.refresh(first.tokens.refreshToken);

      advance(60);
      expect(await errorCode(auth.refresh(first.tokens.refreshToken))).toBe("invalid_refresh_token");
      // The legitimate holder of the newest token is signed out too: safe by default.
      expect(await errorCode(auth.refresh(next.tokens.refreshToken))).toBe("invalid_refresh_token");
      expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
    });

    it("does not let theft in one session touch another", async () => {
      await signUp();
      const phone = await signIn();
      const laptop = await signIn();
      const next = await auth.refresh(phone.tokens.refreshToken);
      advance(60);
      await errorCode(auth.refresh(phone.tokens.refreshToken)); // replay: kills the phone's family
      await expect(auth.refresh(laptop.tokens.refreshToken)).resolves.toBeDefined();
      expect(await errorCode(auth.refresh(next.tokens.refreshToken))).toBe("invalid_refresh_token");
    });

    it("lets exactly one of two simultaneous refreshes win", async () => {
      const first = await signUp();
      const results = await Promise.allSettled([
        auth.refresh(first.tokens.refreshToken),
        auth.refresh(first.tokens.refreshToken),
      ]);
      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect((lost[0].reason as AuthError).code).toBe("refresh_in_flight");
      // One successor, not two.
      expect(await prisma.refreshToken.count()).toBe(2);
    });

    it("rejects an unknown or expired refresh token", async () => {
      expect(await errorCode(auth.refresh("x".repeat(43)))).toBe("invalid_refresh_token");

      const first = await signUp();
      advance(31 * 86_400);
      expect(await errorCode(auth.refresh(first.tokens.refreshToken))).toBe("invalid_refresh_token");
    });

    it("signs out: the token stops working, and signing out again is harmless", async () => {
      const first = await signUp();
      await auth.logout(first.tokens.refreshToken);
      expect(await errorCode(auth.refresh(first.tokens.refreshToken))).toBe("invalid_refresh_token");
      await expect(auth.logout(first.tokens.refreshToken)).resolves.toBeUndefined();
      await expect(auth.logout("never-issued-token-never-issued-token")).resolves.toBeUndefined();
    });

    it("signs out of every device", async () => {
      const { user } = await signUp();
      const a = await signIn();
      const b = await signIn();
      await auth.logoutEverywhere(user.id);
      expect(await errorCode(auth.refresh(a.tokens.refreshToken))).toBe("invalid_refresh_token");
      expect(await errorCode(auth.refresh(b.tokens.refreshToken))).toBe("invalid_refresh_token");
    });

    it("ends the session of an account suspended mid-session", async () => {
      const first = await signUp();
      await prisma.user.update({ where: { id: first.user.id }, data: { status: "SUSPENDED" } });
      expect(await errorCode(auth.refresh(first.tokens.refreshToken))).toBe("invalid_refresh_token");
      expect(await auth.currentUser(first.user.id)).toBeNull();
    });
  });

  describe("profile", () => {
    it("returns the current user, and null for one that does not exist", async () => {
      const { user } = await signUp();
      expect(await auth.currentUser(user.id)).toMatchObject({ id: user.id, phone: PHONE });
      expect(await auth.currentUser("00000000-0000-4000-8000-000000000000")).toBeNull();
    });

    it("updates name and email, and can clear the email", async () => {
      const { user } = await signUp(PHONE, "Asha Rao", "a@example.com");
      expect(await auth.updateProfile(user.id, { name: "Asha R. Rao" })).toMatchObject({ name: "Asha R. Rao", email: "a@example.com" });
      expect(await auth.updateProfile(user.id, { email: null })).toMatchObject({ email: null });
    });

    it("refuses an email that belongs to someone else", async () => {
      await signUp(PHONE, "Asha Rao", "taken@example.com");
      advance(31);
      const other = await signUp(OTHER_PHONE, "Ravi");
      expect(await errorCode(auth.updateProfile(other.user.id, { email: "taken@example.com" }))).toBe("email_taken");
    });

    it("does not let a suspended account edit itself with an old token", async () => {
      const { user } = await signUp();
      await prisma.user.update({ where: { id: user.id }, data: { status: "SUSPENDED" } });
      expect(await errorCode(auth.updateProfile(user.id, { name: "Still Here" }))).toBe("not_found");
    });
  });

  describe("database guarantees", () => {
    it("refuses a phone number that is not an Indian mobile, whatever the application does", async () => {
      await expect(
        prisma.user.create({
          data: { phone: "+14155552671", name: "X", phoneVerifiedAt: new Date(), termsAcceptedAt: new Date() },
        }),
      ).rejects.toThrow();
    });
  });
});
