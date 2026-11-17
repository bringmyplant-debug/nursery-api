/**
 * End-to-end check of sign-up and sign-in against the running stack,
 * entirely through the gateway (the way a real client reaches it).
 *
 *   node scripts/verify-auth.js
 *
 * Needs the stack up and seeded, with the identity service on the console
 * SMS provider (the default in development): the script reads the one-time
 * code from the identity service's dev-only internal endpoint, the same way
 * a developer would read it from the log.
 *
 * Creates one throwaway account per run. Takes ~15s (it waits out the
 * refresh-token reuse grace window).
 */
const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:4000";
const IDENTITY = process.env.IDENTITY_URL ?? "http://localhost:4104";
const TOKEN = process.env.INTERNAL_API_TOKEN ?? "dev-internal-token-change-me";

let passed = 0;
const failures = [];

function check(label, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The gateway rate-limits per client address and believes X-Forwarded-For
 * from a trusted peer (here: loopback, like the Next.js server). A real
 * flow spans many users, so present a fresh address every few calls rather
 * than one client making 40 auth requests a minute.
 */
let calls = 0;
const nextClient = () => `198.51.100.${1 + Math.floor(calls++ / 8) % 250}`;

async function api(method, path, { body, token, client } = {}) {
  const res = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: {
      "x-forwarded-for": client ?? nextClient(),
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, headers: res.headers };
}

async function devCode(phone) {
  const res = await fetch(`${IDENTITY}/internal/dev/otp/${encodeURIComponent(phone)}`, {
    headers: { "x-internal-token": TOKEN },
  });
  if (!res.ok) throw new Error(`no dev code for ${phone} (HTTP ${res.status}); is SMS_PROVIDER=console?`);
  return (await res.json()).code;
}

/** Ask for a code, waiting out the resend cooldown if a previous run left one. */
async function requestCode(phone) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await api("POST", "/v1/auth/otp/request", { body: { phone } });
    if (res.status === 200) return res;
    if (res.status === 429 && res.json?.retryAfterSeconds) {
      console.log(`       (cooldown, waiting ${res.json.retryAfterSeconds}s)`);
      await sleep((res.json.retryAfterSeconds + 1) * 1000);
      continue;
    }
    return res;
  }
  throw new Error("could not obtain a code");
}

const decodeClaims = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());

async function signInWithCode(phone) {
  const req = await requestCode(phone);
  if (req.status !== 200) throw new Error(`otp request failed: ${req.status} ${JSON.stringify(req.json)}`);
  return api("POST", "/v1/auth/otp/verify", { body: { phone, code: await devCode(phone) } });
}

(async () => {
  const suffix = String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  const phone = `+9190${suffix}`;
  // Unique per run: emails are unique, so a fixed one would collide with the previous run.
  const emailInput = ` Test.Person.${suffix}@Example.com `;
  console.log(`account under test: ${phone}\n`);

  console.log("gateway");
  const health = await api("GET", "/health");
  check("identity is part of aggregated health", health.json?.services?.identity?.state === "up", JSON.stringify(health.json?.services?.identity?.state));
  check("/internal is not reachable from outside", (await api("GET", "/internal/dev/otp/9876543210")).status === 404);

  console.log("\nrequesting a code");
  const bad = await api("POST", "/v1/auth/otp/request", { body: { phone: "12345" } });
  check("a malformed number is refused", bad.status === 400 && bad.json?.code === "invalid_phone");
  const foreign = await api("POST", "/v1/auth/otp/request", { body: { phone: "+14155552671" } });
  check("a non-Indian number is refused", foreign.status === 400 && foreign.json?.code === "invalid_phone");
  const extra = await api("POST", "/v1/auth/otp/request", { body: { phone: "9876543210", role: "ADMIN" } });
  check("unknown fields are rejected, not ignored", extra.status === 400);

  const first = await requestCode(phone);
  check("a code is sent", first.status === 200 && first.json?.expiresInSeconds > 0);
  const again = await api("POST", "/v1/auth/otp/request", { body: { phone } });
  check("a second request within the cooldown is throttled, with a wait time", again.status === 429 && again.json?.retryAfterSeconds > 0);

  console.log("\nsign-up");
  const code = await devCode(phone);
  const wrong = code === "000000" ? "111111" : "000000";
  const wrongTry = await api("POST", "/v1/auth/otp/verify", { body: { phone, code: wrong } });
  check("a wrong code is refused", wrongTry.status === 401 && wrongTry.json?.code === "invalid_code");

  const verified = await api("POST", "/v1/auth/otp/verify", { body: { phone, code } });
  check("a right code for a new number asks for a profile", verified.json?.status === "profile_required" && !!verified.json?.signupToken);
  check("no tokens are issued before the profile is complete", !verified.json?.tokens);
  const signupToken = verified.json?.signupToken;

  const reuse = await api("POST", "/v1/auth/otp/verify", { body: { phone, code } });
  check("the code cannot be used twice", reuse.status === 401);

  const noTerms = await api("POST", "/v1/auth/signup", { body: { signupToken, name: "Test Person", acceptTerms: false } });
  check("terms must be accepted", noTerms.status === 400);
  const badName = await api("POST", "/v1/auth/signup", { body: { signupToken, name: "<script>", acceptTerms: true } });
  check("a name with markup is refused", badName.status === 400);
  const badToken = await api("POST", "/v1/auth/signup", { body: { signupToken: "not-a-token", name: "Test Person", acceptTerms: true } });
  check("a forged verification token is refused", badToken.status === 401 && badToken.json?.code === "invalid_signup_token");
  const hostile = await api("POST", "/v1/auth/signup", { body: { signupToken, name: "Test Person", acceptTerms: true, role: "ADMIN" } });
  check("a client cannot choose its own role", hostile.status === 400);

  const signup = await api("POST", "/v1/auth/signup", {
    body: { signupToken, name: "  Test   Person ", email: emailInput, acceptTerms: true },
  });
  check("sign-up succeeds", signup.status === 201 && signup.json?.user?.phone === phone);
  check("the name is tidied and the email lower-cased", signup.json?.user?.name === "Test Person" && signup.json?.user?.email === emailInput.trim().toLowerCase());
  check("the new account is a buyer", signup.json?.user?.role === "BUYER" && decodeClaims(signup.json.tokens.accessToken).role === "BUYER");

  const again2 = await api("POST", "/v1/auth/signup", { body: { signupToken, name: "Test Person", acceptTerms: true } });
  check("the same verification cannot register twice", again2.status === 409 && again2.json?.code === "already_registered");

  console.log("\nsession");
  let tokens = signup.json.tokens;
  const me = await api("GET", "/v1/auth/me", { token: tokens.accessToken });
  check("the access token identifies the user", me.status === 200 && me.json?.user?.id === signup.json.user.id);
  check("no token, no access", (await api("GET", "/v1/auth/me")).status === 401);
  check("a garbage token is refused", (await api("GET", "/v1/auth/me", { token: "a.b.c" })).status === 401);
  const [h, p, s] = tokens.accessToken.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ ...decodeClaims(tokens.accessToken), role: "ADMIN" })).toString("base64url");
  check("a token with an edited role is refused", (await api("GET", "/v1/auth/me", { token: `${h}.${forgedPayload}.${s}` })).status === 401);
  check("a signup token is not an access token", (await api("GET", "/v1/auth/me", { token: signupToken })).status === 401);

  const patched = await api("PATCH", "/v1/auth/me", { token: tokens.accessToken, body: { name: "Test P. Person" } });
  check("the profile can be edited", patched.status === 200 && patched.json?.user?.name === "Test P. Person");
  const roleEdit = await api("PATCH", "/v1/auth/me", { token: tokens.accessToken, body: { role: "ADMIN" } });
  check("role cannot be edited through the profile", roleEdit.status === 400);
  const noMembership = await api("GET", "/v1/nurseries/mine", { token: tokens.accessToken });
  check("an ordinary buyer belongs to no nursery (verified by a second service)", noMembership.status === 200 && noMembership.json?.data?.length === 0);
  check("the nursery list needs a token", (await api("GET", "/v1/nurseries/mine")).status === 401);

  console.log("\nrefresh rotation");
  const oldRefresh = tokens.refreshToken;
  const rotated = await api("POST", "/v1/auth/refresh", { body: { refreshToken: oldRefresh } });
  check("a refresh token buys a new pair", rotated.status === 200 && rotated.json?.tokens?.refreshToken !== oldRefresh);
  const racing = await api("POST", "/v1/auth/refresh", { body: { refreshToken: oldRefresh } });
  check("using the old token again at once is a concurrent request (409), not theft", racing.status === 409 && racing.json?.code === "refresh_in_flight");
  const stillAlive = await api("POST", "/v1/auth/refresh", { body: { refreshToken: rotated.json.tokens.refreshToken } });
  check("...and the session survives it", stillAlive.status === 200);
  tokens = stillAlive.json.tokens;

  console.log("       (waiting out the 10s reuse grace window)");
  await sleep(11_000);
  const stolen = await api("POST", "/v1/auth/refresh", { body: { refreshToken: oldRefresh } });
  check("replaying a long-spent token is treated as theft (401)", stolen.status === 401);
  const afterTheft = await api("POST", "/v1/auth/refresh", { body: { refreshToken: tokens.refreshToken } });
  check("...and ends the whole session, even for the legitimate holder", afterTheft.status === 401);

  console.log("\nsign-in");
  const signedIn = await signInWithCode(phone);
  check("a registered number signs straight in", signedIn.status === 200 && signedIn.json?.status === "signed_in" && signedIn.json?.user?.id === signup.json.user.id);
  const out = await api("POST", "/v1/auth/logout", { body: { refreshToken: signedIn.json.tokens.refreshToken } });
  check("sign-out succeeds", out.status === 204);
  const afterOut = await api("POST", "/v1/auth/refresh", { body: { refreshToken: signedIn.json.tokens.refreshToken } });
  check("a signed-out session cannot be refreshed", afterOut.status === 401);
  const outAgain = await api("POST", "/v1/auth/logout", { body: { refreshToken: signedIn.json.tokens.refreshToken } });
  check("signing out twice is harmless", outAgain.status === 204);

  console.log("\nseeded accounts");
  const owner = await signInWithCode("+919000000003");
  check("the nursery owner signs in", owner.json?.status === "signed_in");
  const mine = await api("GET", "/v1/nurseries/mine", { token: owner.json?.tokens?.accessToken });
  check("...and the partner service knows their nursery", mine.status === 200 && mine.json?.data?.[0]?.slug === "green-canopy-nursery" && mine.json.data[0].role === "OWNER", JSON.stringify(mine.json));
  const admin = await signInWithCode("+919000000001");
  check("the admin's token carries the ADMIN role", admin.json?.status === "signed_in" && decodeClaims(admin.json.tokens.accessToken).role === "ADMIN");

  console.log("\nrate limiting");
  let limited = 0;
  for (let i = 0; i < 30; i++) {
    const r = await api("POST", "/v1/auth/otp/request", { body: { phone: "12345" }, client: "203.0.113.77" });
    if (r.status === 429) limited++;
  }
  check("the gateway throttles a burst against /v1/auth", limited > 0, `${limited} of 30 throttled`);
  check("browsing is unaffected", (await api("GET", "/v1/plants?city=Pune&limit=1", { client: "203.0.113.77" })).status === 200);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("failed:\n  - " + failures.join("\n  - "));
    process.exit(1);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
