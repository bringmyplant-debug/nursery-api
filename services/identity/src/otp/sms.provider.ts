import { Logger } from "@nestjs/common";
import { maskPhone } from "../users/phone";

/** DI token for the configured {@link SmsProvider}. */
export const SMS_PROVIDER = Symbol("SMS_PROVIDER");

export interface SmsProvider {
  /** Deliver `code` to `phone` (E.164). Rejects if it could not be handed to the carrier. */
  sendOtp(phone: string, code: string): Promise<void>;
}

/**
 * Development provider: prints the code instead of sending it.
 *
 * It also remembers the latest code per phone, so a developer or a test
 * script can fetch it from the internal dev endpoint instead of scraping a
 * log. That is exactly why production refuses to start with this provider
 * (see `assertProductionSafe`): a service that reveals its own one-time
 * codes has no authentication.
 */
export class ConsoleSmsProvider implements SmsProvider {
  private readonly logger = new Logger("ConsoleSms");
  private readonly latest = new Map<string, { code: string; at: number }>();

  async sendOtp(phone: string, code: string): Promise<void> {
    this.latest.set(phone, { code, at: Date.now() });
    this.logger.warn(`OTP for ${maskPhone(phone)}: ${code}   (console provider: nothing was sent)`);
  }

  peek(phone: string): string | null {
    return this.latest.get(phone)?.code ?? null;
  }
}

export interface Msg91Options {
  authKey: string;
  templateId: string;
  /** The variable name the approved template uses for the code. */
  otpVariable: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * MSG91 "flow" API adapter.
 *
 * UNVERIFIED. Written from memory of the v5 flow endpoint; MSG91's
 * documentation could not be retrieved while building this, and it has not
 * been exercised against a real account. Before relying on it:
 *
 *  - confirm the endpoint, header and body shape against their current docs;
 *  - register the sender and the OTP template under India's DLT rules, which
 *    carriers enforce, and put the approved template id in MSG91_TEMPLATE_ID;
 *  - confirm `otpVariable` matches the variable in that template.
 *
 * It is behind the {@link SmsProvider} interface precisely so this is the
 * only file that changes if any of it is wrong.
 */
export class Msg91SmsProvider implements SmsProvider {
  private readonly logger = new Logger("Msg91Sms");

  constructor(private readonly options: Msg91Options) {}

  async sendOtp(phone: string, code: string): Promise<void> {
    const { authKey, templateId, otpVariable, timeoutMs = 5_000, fetchImpl = fetch } = this.options;

    const response = await fetchImpl("https://control.msg91.com/api/v5/flow/", {
      method: "POST",
      headers: { authkey: authKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        template_id: templateId,
        short_url: "0",
        recipients: [{ mobiles: phone.replace(/^\+/, ""), [otpVariable]: code }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const body = (await response.json().catch(() => null)) as { type?: string; message?: string } | null;
    if (!response.ok || body?.type !== "success") {
      // The provider's message can include the number; log status only.
      this.logger.error(`MSG91 rejected the send for ${maskPhone(phone)} (HTTP ${response.status}, type=${body?.type ?? "unknown"})`);
      throw new Error(`MSG91 send failed with HTTP ${response.status}`);
    }
  }
}
