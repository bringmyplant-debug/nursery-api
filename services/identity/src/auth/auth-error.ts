import { HttpException, HttpStatus } from "@nestjs/common";

export type AuthErrorCode =
  | "invalid_phone"
  | "invalid_code"
  | "too_many_attempts"
  | "too_many_requests"
  | "sms_unavailable"
  | "invalid_signup_token"
  | "already_registered"
  | "email_taken"
  | "invalid_refresh_token"
  | "refresh_in_flight"
  | "account_suspended"
  | "not_found";

/**
 * Every failure a client can see from the auth endpoints carries a stable
 * machine-readable `code` alongside the human message, so a UI can choose
 * its wording (and its language) without parsing English.
 */
export class AuthError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: AuthErrorCode,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super({ statusCode: status, code, message, ...extra }, status);
  }

  static invalidPhone(): AuthError {
    return new AuthError(HttpStatus.BAD_REQUEST, "invalid_phone", "Enter a valid 10-digit Indian mobile number.");
  }

  /** One answer for wrong, expired and unknown codes: which of the three it was is nobody's business. */
  static invalidCode(): AuthError {
    return new AuthError(HttpStatus.UNAUTHORIZED, "invalid_code", "That code is incorrect or has expired.");
  }

  static tooManyAttempts(): AuthError {
    return new AuthError(
      HttpStatus.TOO_MANY_REQUESTS,
      "too_many_attempts",
      "Too many incorrect attempts. Request a new code.",
    );
  }

  static tooManyRequests(retryAfterSeconds: number): AuthError {
    return new AuthError(HttpStatus.TOO_MANY_REQUESTS, "too_many_requests", "Please wait before requesting another code.", {
      retryAfterSeconds,
    });
  }

  static smsUnavailable(): AuthError {
    return new AuthError(HttpStatus.SERVICE_UNAVAILABLE, "sms_unavailable", "We could not send the code. Please try again shortly.");
  }

  static invalidSignupToken(): AuthError {
    return new AuthError(
      HttpStatus.UNAUTHORIZED,
      "invalid_signup_token",
      "Your verification has expired. Please verify your number again.",
    );
  }

  static alreadyRegistered(): AuthError {
    return new AuthError(HttpStatus.CONFLICT, "already_registered", "This number is already registered. Sign in instead.");
  }

  static emailTaken(): AuthError {
    return new AuthError(HttpStatus.CONFLICT, "email_taken", "That email is already in use.");
  }

  static invalidRefreshToken(): AuthError {
    return new AuthError(HttpStatus.UNAUTHORIZED, "invalid_refresh_token", "Your session has ended. Please sign in again.");
  }

  /** Two requests refreshed at once. The caller should retry with the token the winner issued. */
  static refreshInFlight(): AuthError {
    return new AuthError(HttpStatus.CONFLICT, "refresh_in_flight", "This session was just refreshed by another request.");
  }

  static accountSuspended(): AuthError {
    return new AuthError(HttpStatus.FORBIDDEN, "account_suspended", "This account has been suspended. Contact support.");
  }

  static notFound(): AuthError {
    return new AuthError(HttpStatus.NOT_FOUND, "not_found", "Not found.");
  }
}
