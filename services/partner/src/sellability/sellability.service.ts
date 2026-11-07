import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DATABASE, type Database, OutboxRelay, PeriodicJob } from "@nursery-co/platform";
import { SellabilityEngine } from "./sellability.engine";
import type { Transition } from "./sellability.logic";

/**
 * Nest wrapper around {@link SellabilityEngine}: adds the periodic sweep
 * and nudges the outbox relay after a change so announcements go out in
 * milliseconds instead of waiting for the next poll.
 */
@Injectable()
export class SellabilityService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SellabilityService.name);
  private readonly engine: SellabilityEngine;
  private readonly sweep: PeriodicJob;

  constructor(
    @Inject(DATABASE) db: Database,
    private readonly relay: OutboxRelay,
    config: ConfigService,
  ) {
    this.engine = new SellabilityEngine(db);
    this.sweep = new PeriodicJob(
      () => this.reconcileDrifted().then(() => undefined),
      config.get<number>("SELLABILITY_SWEEP_SECONDS", 60) * 1000,
      (error) => this.logger.error(`sweep failed: ${error instanceof Error ? error.message : error}`),
    );
  }

  onApplicationBootstrap(): void {
    // Also announces, on first boot, every nursery nobody has announced yet.
    void this.sweep.runNow().catch((e) => this.logger.error(`initial sweep failed: ${e}`));
    this.sweep.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.sweep.stop();
  }

  async reconcileNursery(nurseryId: string, correlationId?: string): Promise<Transition | null> {
    const transition = await this.engine.reconcileNursery(nurseryId, correlationId);
    if (transition) this.relay.kick();
    return transition;
  }

  async reconcileDrifted(): Promise<number> {
    const changed = await this.engine.reconcileDrifted();
    if (changed > 0) {
      this.logger.log(`announced ${changed} sellability change(s)`);
      this.relay.kick();
    }
    return changed;
  }

  async republishAll(): Promise<number> {
    const count = await this.engine.republishAll();
    this.relay.kick();
    return count;
  }
}
