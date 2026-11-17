# Sign-in and sign-up

One flow, by phone number, with no passwords.

```
phone ─▶ code (SMS) ─▶ known number? ──yes──▶ signed in
                              └─────no────▶ name + terms ─▶ signed in
```

A returning customer and a new one start identically. Which of the two they
are is only revealed *after* they have proved they hold the number, so the
endpoints cannot be used to list who has an account, and no account is ever
created for a number nobody verified.

Phone is the identity because that is what Indian nurseries and buyers
reliably have; email is optional, unverified, and not used to sign in.

## Pieces

| Where | What |
|---|---|
| `services/identity` (:4104) | Users, one-time codes, sessions. The only service that can *sign* tokens. |
| `packages/platform/src/auth` | Token sign/verify and `JwtAuthGuard`. Every other service verifies tokens itself. |
| `gateway` | Exposes `/v1/auth/*` (the only public routes that accept writes), with its own rate limit. |
| `services/partner` | `GET /v1/nurseries/mine`: proves tokens verify in a second service, and answers "which nurseries may this person act for". |
| `nursery-web` | The sign-in UI, Server Actions, and `proxy.ts` (silent refresh and route gating). |

## API (all through the gateway, under `/v1/auth`)

| Endpoint | Purpose |
|---|---|
| `POST /otp/request` `{phone}` | Send a code. Same answer whether or not the number has an account. |
| `POST /otp/verify` `{phone, code}` | `signed_in` + tokens, or `profile_required` + a 10-minute `signupToken`. |
| `POST /signup` `{signupToken, name, email?, acceptTerms: true}` | Create the account, return tokens. |
| `POST /refresh` `{refreshToken}` | Rotate. 409 `refresh_in_flight` means a concurrent request won; retry. 401 means sign in again. |
| `POST /logout` `{refreshToken}` | End this session. Always 204. |
| `POST /logout-all` (bearer) | End every session. |
| `GET /me`, `PATCH /me` (bearer) | The user; edit name or email. Phone and role cannot be edited here. |

Failures carry a stable `code` (`invalid_code`, `too_many_attempts`, `too_many_requests` with
`retryAfterSeconds`, `email_taken`, …) so a UI chooses its own wording and language.

## What protects what

**One-time codes.** Six digits from the OS CSPRNG. Stored as an HMAC keyed with a server-side
pepper and bound to the challenge id, never the code: a database leak cannot be replayed (six
digits fall to a plain hash in milliseconds). Valid 5 minutes; five guesses, counted *before*
comparing, in one conditional `UPDATE`, so parallel guesses cannot beat the cap; single use, also
by conditional `UPDATE`, so two simultaneous correct submissions admit one. Requesting a new code
kills the previous one. Per number: 30 s between codes, 5 per hour. Worst case an attacker gets
25 guesses an hour against one number, about a 2.5e-5 chance per hour per target; the gateway's
per-IP limit and the Indian-mobile-only rule (which stops SMS pumping to foreign premium routes)
sit on top.

**Sessions.** Access token: ES256 JWT, 15 minutes, signed only by identity; services hold the
public key, so a compromised catalogue can verify tokens but never mint one. Verification pins
the algorithm, issuer and audience, which defeats `alg: none` and the HS256-with-public-key
confusion attack (both tested). The signup token has a different audience, so it can never be
presented as an access token, nor the reverse.

Refresh token: 256 random bits, only its SHA-256 stored, **single use**. Each refresh issues a
new one in the same family. Presenting a token that was already spent is what theft looks like (the
owner and the thief both hold it), so a spent token presented *later* revokes the whole family.
A spent token presented within 10 seconds is treated as two requests racing (a browser can send
two at once) and answered 409 without punishing the session.

**The web layer.** Tokens live only in httpOnly cookies set by the Next.js server, so page
JavaScript, and therefore XSS, cannot read them (checked: `document.cookie` is empty and storage
is empty after sign-in). SameSite=Lax; `__Host-` prefixed in production. Every step is a Server
Action, which Next checks for same-origin; each re-validates its own input and authenticates for
itself rather than trusting the proxy. The `next` redirect parameter is attacker-writable and is
reduced to a same-site path (`//host`, `/\host`, `/.//host`, `javascript:` and friends all fall back).

**Rate limiting.** The gateway limits per client IP, with a much lower bucket for `/v1/auth`.
Because every user reaches it through the web server, the web server forwards the real client
address in `X-Forwarded-For`, and the gateway believes that header only from peers in
`TRUST_PROXY` (default `loopback`). In production set it to your load balancer/web-server
addresses; and whatever sits in front of Next.js must set `X-Forwarded-For` honestly, or every
user shares one bucket.

## Running it

```bash
node scripts/generate-jwt-keys.js        # creates .keys/ (git-ignored). Once per machine.
npm run infra:up
npm run db:migrate && npm run db:seed
npm run dev
npm run verify:auth                       # 42 end-to-end checks through the gateway
```

In development the SMS provider is `console`: the code is printed in the identity service's log,
and `GET :4104/internal/dev/otp/<phone>` (with `x-internal-token`) returns it, which is what the
verification script uses. Seeded accounts (never seeded in production):

| Phone | Who |
|---|---|
| `+91 90000 00001` | Admin: can open `/admin` |
| `+91 90000 00002` | A buyer |
| `+91 90000 00003` | Owner of Green Canopy: can open `/dashboard` |

Web needs `GATEWAY_URL` (server-side only), default `http://localhost:4000`.

**Existing Postgres volume?** The init script only runs on an empty volume, so create the identity
database once by hand: see the `CREATE ROLE svc_identity …` block in
`docker/postgres/init/01-service-databases.sh`, or run `npm run infra:reset` (deletes local data).

## Tests

- 62 unit tests in identity (code generation and hashing, challenge state, refresh classification, phone parsing, config).
- 43 integration tests against a real Postgres (the `_shadow` database; they refuse to run against anything else, and skip if Postgres is unreachable): lockout, single use, races, rotation, theft detection, suspended users, DB constraints.
- 18 JWT tests including `alg: none`, key confusion, audience separation.
- Gateway: body and bearer forwarding, write methods only where allowed, separate auth bucket, `X-Forwarded-For` trust.
- Web: 45 tests for the redirect sanitiser and phone handling.
- `npm run verify:auth`: the whole flow against the live stack.
- Browser-verified by hand: sign-up, wrong code, validation, sign-in as a returning user, profile edit, sign-out, redirect-back, `/admin` as admin (console) and as a buyer (404), `/dashboard` as owner (console) and as a buyer (no nursery), silent refresh after the access cookie expired.

## Not done, or unverified

- **The MSG91 SMS adapter has never been run.** Their documentation could not be fetched while building this, so the request shape in `services/identity/src/otp/sms.provider.ts` is from memory. Confirm it, and complete India's DLT sender/template registration, before sending a real SMS. Production refuses to boot on the console provider.
- **The terms checkbox links nowhere**: there is no terms or privacy page yet, and those need writing by someone qualified rather than drafted here.
- **No CAPTCHA or bot defence** beyond the rate limits.
- **Hindi, Marathi and Punjabi strings** were written without a native-speaker review.
- **Suspending or changing a user takes effect within one access-token lifetime** (≤15 min) for services that only check the token; the web app asks identity on each render and sees it at once.
- **Accounts cannot be deleted or change phone number** yet; changing a number needs its own verified flow.
- **Saved plants, enquiries, addresses and notification settings** on the account page are empty states: no backend exists for them.
- **The dashboard and admin console still render demo fixtures**; only access to them is real. (Nursery membership comes from the partner service, so it shows the right nursery's name but fixture contents.)
- The internal service token is still one shared secret (see ARCHITECTURE.md).
