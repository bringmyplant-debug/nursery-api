import { Logger } from "@nestjs/common";
import {
  AckPolicy,
  DeliverPolicy,
  DiscardPolicy,
  JetStreamApiError,
  RetentionPolicy,
  StorageType,
  jetstream,
  jetstreamManager,
  type JetStreamClient,
  type JetStreamManager,
  type JsMsg,
} from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import {
  STREAM_DUPLICATE_WINDOW_SECONDS,
  STREAM_MAX_AGE_SECONDS,
  STREAM_NAME,
  STREAM_SUBJECTS,
  isEnvelope,
  type EventEnvelope,
} from "@nursery-co/contracts";
import { retryDelayMs } from "../backoff";
import type { EventBus, SubscribeOptions } from "./bus";

/** JetStream `err_code` values. The client enum only names some of them. */
const ERR_STREAM_NOT_FOUND = 10059;
const ERR_STREAM_NAME_IN_USE = 10058;
const ERR_CONSUMER_NAME_IN_USE = 10148;

const NANOS_PER_SECOND = 1_000_000_000;
const PUBLISH_TIMEOUT_MS = 5_000;

/**
 * How long a handler has to finish before the broker assumes it died and
 * redelivers. Generous, because redelivering a message that is merely slow
 * means processing it twice.
 */
const ACK_WAIT_SECONDS = 60;

/**
 * Backstop only. The service dead-letters a poison message long before
 * this (see EventConsumer); this stops the broker redelivering one forever
 * if the service is down and cannot do so.
 */
const BROKER_MAX_DELIVER = 25;

interface Registered {
  options: SubscribeOptions;
  started: boolean;
}

/**
 * {@link EventBus} over NATS JetStream.
 *
 * Connection is established in the background and retried forever. A
 * service must boot, and keep answering its read endpoints, while the
 * broker is down — the catalogue serving slightly stale availability is a
 * far better failure than the catalogue refusing to start. Publishing
 * rejects until connected, which the outbox relay handles by backing off;
 * consumers simply begin when the connection arrives.
 */
export class NatsEventBus implements EventBus {
  private readonly logger = new Logger(NatsEventBus.name);
  private readonly registered: Registered[] = [];
  private readonly openStreams: { close(): Promise<void | Error> }[] = [];

  private connection?: NatsConnection;
  private js?: JetStreamClient;
  private connected = false;
  /** False between a drop and the client re-establishing the link; the client reconnects on its own. */
  private online = false;
  private closing = false;
  private establishing?: Promise<void>;

  constructor(private readonly options: { url: string; service: string }) {}

  /** Nest lifecycle: begin connecting, but do not hold boot hostage to it. */
  async onModuleInit(): Promise<void> {
    this.establishing = this.establish();
    // Wait briefly so the common case — broker already up — starts fully
    // connected, but never indefinitely.
    await Promise.race([this.establishing, sleep(3_000)]);
  }

  /** Runs after every module's own destroy hooks, so the relay stops first. */
  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }

  isHealthy(): boolean {
    return this.connected && this.online && !!this.connection && !this.connection.isClosed();
  }

  async publish(event: EventEnvelope): Promise<void> {
    if (!this.js || !this.isHealthy()) {
      throw new Error("event bus not connected");
    }
    await this.js.publish(event.type, JSON.stringify(event), {
      // The broker drops a second message carrying an id it has already
      // seen. This is what makes "relay crashed after publishing but
      // before marking it published" harmless.
      msgID: event.id,
      timeout: PUBLISH_TIMEOUT_MS,
    });
  }

  async subscribe(options: SubscribeOptions): Promise<void> {
    this.registered.push({ options, started: false });
    if (this.connected) await this.startPending();
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.connected = false;
    this.online = false;

    await Promise.allSettled(this.openStreams.map((s) => s.close()));
    this.openStreams.length = 0;

    if (this.connection && !this.connection.isClosed()) {
      // Drain flushes anything buffered, so an event published a moment
      // before shutdown is not lost to a closed socket.
      await this.connection.drain().catch(() => undefined);
    }
  }

  /* ---------------------------------------------------------- connection */

  private async establish(): Promise<void> {
    for (let attempt = 1; !this.closing; attempt++) {
      try {
        const nc = await connect({
          servers: this.options.url,
          name: this.options.service,
          // -1: keep reconnecting for as long as the process lives.
          maxReconnectAttempts: -1,
        });
        this.connection = nc;

        const manager = await jetstreamManager(nc);
        await ensureStream(manager);
        this.js = jetstream(nc);

        this.connected = true;
        this.online = true;
        this.logger.log(`connected to ${this.options.url}`);
        void this.watchConnection(nc);
        await this.startPending();
        return;
      } catch (error) {
        const wait = retryDelayMs(attempt, { maxMs: 15_000 });
        this.logger.warn(
          `bus connection attempt ${attempt} failed (${describe(error)}); retrying in ${wait}ms`,
        );
        await sleep(wait);
      }
    }
  }

  /** Surface drops and recoveries in the log. The client reconnects itself. */
  private async watchConnection(nc: NatsConnection): Promise<void> {
    try {
      for await (const status of nc.status()) {
        if (this.closing) return;
        if (status.type === "disconnect") {
          this.online = false;
          this.logger.warn("bus disconnected");
        }
        if (status.type === "reconnect") {
          this.online = true;
          this.logger.log("bus reconnected");
        }
      }
    } catch {
      /* iterator ends when the connection closes */
    }
  }

  /* ----------------------------------------------------------- consumers */

  private async startPending(): Promise<void> {
    for (const entry of this.registered) {
      if (entry.started) continue;
      entry.started = true;
      void this.runConsumer(entry.options);
    }
  }

  private async runConsumer(options: SubscribeOptions): Promise<void> {
    for (let attempt = 1; !this.closing; attempt++) {
      try {
        const nc = this.connection;
        const js = this.js;
        if (!nc || !js) throw new Error("not connected");

        const manager = await jetstreamManager(nc);
        await ensureConsumer(manager, options);

        const consumer = await js.consumers.get(STREAM_NAME, options.durable);
        const messages = await consumer.consume({ max_messages: 25 });
        this.openStreams.push(messages);
        this.logger.log(`consuming ${options.subjects.join(", ")} as "${options.durable}"`);
        attempt = 0; // a healthy run resets the backoff

        // Sequential on purpose: a for-await processes one message fully
        // before the next, which preserves per-subject order. Parallelism
        // would be faster and would let a stale event overtake a newer one.
        for await (const msg of messages) {
          await this.handle(options, msg);
        }
        if (this.closing) return;
        this.logger.warn(`consumer "${options.durable}" stream ended; restarting`);
      } catch (error) {
        if (this.closing) return;
        const wait = retryDelayMs(attempt || 1, { maxMs: 15_000 });
        this.logger.warn(`consumer "${options.durable}" failed (${describe(error)}); retry in ${wait}ms`);
        await sleep(wait);
      }
    }
  }

  private async handle(options: SubscribeOptions, msg: JsMsg): Promise<void> {
    let parsed: unknown;
    try {
      parsed = msg.json<unknown>();
    } catch {
      this.logger.error(`dropping unparseable message on ${msg.subject}`);
      msg.term("unparseable");
      return;
    }

    if (!isEnvelope(parsed)) {
      // Cannot be dead-lettered (there is no id to key it by) and cannot
      // ever succeed. Terminate it rather than redeliver it forever.
      this.logger.error(`dropping malformed envelope on ${msg.subject}`);
      msg.term("malformed envelope");
      return;
    }

    try {
      await options.handler(parsed, { deliveryCount: msg.info.deliveryCount });
      msg.ack();
    } catch (error) {
      const delay = retryDelayMs(msg.info.deliveryCount);
      this.logger.warn(
        `handler failed for ${parsed.type} ${parsed.id} (delivery ${msg.info.deliveryCount}): ${describe(error)}; retry in ${delay}ms`,
      );
      msg.nak(delay);
    }
  }
}

/* ------------------------------------------------------------------ setup */

async function ensureStream(manager: JetStreamManager): Promise<void> {
  try {
    await manager.streams.info(STREAM_NAME);
    return;
  } catch (error) {
    if (apiErrorCode(error) !== ERR_STREAM_NOT_FOUND) throw error;
  }

  try {
    await manager.streams.add({
      name: STREAM_NAME,
      subjects: [...STREAM_SUBJECTS],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      discard: DiscardPolicy.Old,
      max_age: STREAM_MAX_AGE_SECONDS * NANOS_PER_SECOND,
      duplicate_window: STREAM_DUPLICATE_WINDOW_SECONDS * NANOS_PER_SECOND,
      num_replicas: 1,
    });
  } catch (error) {
    // Another service created it between our check and our add. Fine —
    // every service asks for the same configuration.
    if (apiErrorCode(error) !== ERR_STREAM_NAME_IN_USE) throw error;
  }
}

async function ensureConsumer(manager: JetStreamManager, options: SubscribeOptions): Promise<void> {
  try {
    await manager.consumers.add(STREAM_NAME, {
      durable_name: options.durable,
      ack_policy: AckPolicy.Explicit,
      // A brand-new consumer replays the retained history, which is how a
      // service added next month bootstraps its projection.
      deliver_policy: DeliverPolicy.All,
      filter_subjects: options.subjects,
      ack_wait: ACK_WAIT_SECONDS * NANOS_PER_SECOND,
      max_deliver: BROKER_MAX_DELIVER,
    });
  } catch (error) {
    // Already exists — the normal case on every restart after the first.
    if (apiErrorCode(error) !== ERR_CONSUMER_NAME_IN_USE) throw error;
  }
}

function apiErrorCode(error: unknown): number | undefined {
  return error instanceof JetStreamApiError ? error.apiError().err_code : undefined;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
