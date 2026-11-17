import { IdentityEnv, assertProductionSafe, validateIdentityEnv } from "./env";

const base = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://x",
  INTERNAL_API_TOKEN: "dev-internal-token-change-me",
  JWT_PRIVATE_KEY_PATH: "a",
  JWT_PUBLIC_KEY_PATH: "b",
  OTP_PEPPER: "dev-only-otp-pepper-change-me-0123456789",
};

const prod = {
  ...base,
  NODE_ENV: "production",
  INTERNAL_API_TOKEN: "a-real-long-random-internal-secret",
  OTP_PEPPER: "a-real-long-random-pepper-0123456789abcdef",
  SMS_PROVIDER: "msg91",
  MSG91_AUTH_KEY: "k",
  MSG91_TEMPLATE_ID: "t",
};

describe("IdentityEnv", () => {
  it("accepts the development defaults", () => {
    expect(() => validateIdentityEnv(base)).not.toThrow();
  });

  it("applies the documented defaults", () => {
    const env = validateIdentityEnv(base) as unknown as IdentityEnv;
    expect(env.OTP_LENGTH).toBe(6);
    expect(env.OTP_MAX_ATTEMPTS).toBe(5);
    expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(env.SMS_PROVIDER).toBe("console");
  });

  it("rejects a short pepper", () => {
    expect(() => validateIdentityEnv({ ...base, OTP_PEPPER: "short" })).toThrow(/OTP_PEPPER/);
  });

  it("rejects an unknown SMS provider", () => {
    expect(() => validateIdentityEnv({ ...base, SMS_PROVIDER: "carrier-pigeon" })).toThrow();
  });
});

describe("assertProductionSafe", () => {
  it("allows a properly configured production", () => {
    expect(() => validateIdentityEnv(prod)).not.toThrow();
  });

  it("refuses the console SMS provider, which would print codes to the log", () => {
    expect(() => validateIdentityEnv({ ...prod, SMS_PROVIDER: "console" })).toThrow(/SMS_PROVIDER=console/);
  });

  it("refuses msg91 without credentials", () => {
    expect(() => validateIdentityEnv({ ...prod, MSG91_AUTH_KEY: undefined })).toThrow(/MSG91_AUTH_KEY/);
  });

  it("refuses placeholder secrets", () => {
    expect(() => validateIdentityEnv({ ...prod, OTP_PEPPER: base.OTP_PEPPER })).toThrow(/OTP_PEPPER/);
    expect(() => validateIdentityEnv({ ...prod, INTERNAL_API_TOKEN: base.INTERNAL_API_TOKEN })).toThrow(/INTERNAL_API_TOKEN/);
  });

  it("reports every problem at once", () => {
    try {
      validateIdentityEnv({ ...prod, SMS_PROVIDER: "console", OTP_PEPPER: base.OTP_PEPPER });
      throw new Error("should have thrown");
    } catch (error) {
      expect(String(error)).toMatch(/SMS_PROVIDER=console[\s\S]*OTP_PEPPER/);
    }
  });

  it("does nothing outside production", () => {
    const env = Object.assign(new IdentityEnv(), { ...base, SMS_PROVIDER: "console" });
    expect(() => assertProductionSafe(env)).not.toThrow();
  });
});
