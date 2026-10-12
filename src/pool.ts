import type { ApnsConnection } from "./connection";
import { PoolClosedError } from "./errors";
import type { Logger } from "./logger";
import type { ApnsClientMetricsListener } from "./metrics";

const MIN_CONNECT_DELAY_SECONDS = 1;
const MAX_CONNECT_DELAY_SECONDS = 60;

interface Waiter {
  resolve(connection: ApnsConnection): void;
  reject(error: unknown): void;
}

/**
 * A bounded pool of connections to the APNs gateway. While below capacity, every acquisition opens a new connection;
 * once full, acquisitions are spread over the open connections (each of which multiplexes many notifications).
 * Failed connection attempts back off exponentially, from one second up to a minute.
 */
export class ApnsConnectionPool {
  private readonly connections: ApnsConnection[] = [];
  private readonly pendingCreations = new Set<Promise<ApnsConnection>>();
  private readonly waiters: Waiter[] = [];
  private currentDelaySeconds = 0;
  private readonly pendingDelays = new Set<() => void>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly connectionFactory: () => Promise<ApnsConnection>,
    private readonly capacity: number,
    private readonly metricsListener: ApnsClientMetricsListener,
    private readonly logger: Logger,
  ) {}

  acquire(): Promise<ApnsConnection> {
    if (this.closed) {
      return Promise.reject(new PoolClosedError());
    }

    if (this.connections.length + this.pendingCreations.size < this.capacity) {
      return this.createConnection();
    }

    const connection = this.pickUsableConnection();
    if (connection) {
      return Promise.resolve(connection);
    }

    // Every slot is taken by a connection still being created (or one that is closing); wait for a slot to free up.
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  /** Closes every connection, waiting for in-flight notifications, and fails any pending acquisitions. */
  close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      for (const wake of this.pendingDelays) wake();
      this.closePromise = (async () => {
        await Promise.all(this.connections.map((connection) => connection.close()));
        await Promise.allSettled([...this.pendingCreations]);
        for (const waiter of this.waiters.splice(0)) {
          waiter.reject(new PoolClosedError());
        }
      })();
    }
    return this.closePromise;
  }

  private createConnection(): Promise<ApnsConnection> {
    const delaySeconds = this.currentDelaySeconds;

    const creation = (async () => {
      if (delaySeconds > 0) {
        this.logger.debug(`Delaying connection attempt by ${delaySeconds} s.`);
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            this.pendingDelays.delete(wake);
            resolve();
          };
          const timer = setTimeout(wake, delaySeconds * 1000);
          this.pendingDelays.add(wake);
        });
      }
      if (this.closed) throw new PoolClosedError();
      return this.connectionFactory();
    })().then(
      (connection) => {
        this.pendingCreations.delete(creation);
        this.currentDelaySeconds = 0;

        if (this.closed) {
          void connection.close();
          throw new PoolClosedError();
        }

        this.connections.push(connection);
        connection.onClose(() => this.removeConnection(connection));
        this.metricsListener.handleConnectionAdded?.();
        this.logger.debug("Created APNs connection.");
        this.serveWaiters();
        return connection;
      },
      (error: unknown) => {
        this.pendingCreations.delete(creation);

        if (!(error instanceof PoolClosedError)) {
          this.currentDelaySeconds = Math.max(
            Math.min(delaySeconds * 2, MAX_CONNECT_DELAY_SECONDS),
            MIN_CONNECT_DELAY_SECONDS,
          );
          this.metricsListener.handleConnectionCreationFailed?.();
          this.logger.warn("Failed to create APNs connection.", error);
        }

        // This acquisition is over, and its caller never got a connection to use. Give the next waiter a turn.
        this.serveNextWaiter();
        throw error;
      },
    );

    this.pendingCreations.add(creation);
    return creation;
  }

  private pickUsableConnection(): ApnsConnection | undefined {
    let best: ApnsConnection | undefined;
    for (const connection of this.connections) {
      if (connection.isUsable && (best === undefined || connection.inFlight < best.inFlight)) {
        best = connection;
      }
    }
    return best;
  }

  private removeConnection(connection: ApnsConnection): void {
    const index = this.connections.indexOf(connection);
    if (index === -1) return;

    this.connections.splice(index, 1);
    this.metricsListener.handleConnectionRemoved?.();
    this.logger.debug("Removed APNs connection from pool.");
    this.serveNextWaiter();
  }

  private serveWaiters(): void {
    while (this.waiters.length > 0) {
      const connection = this.pickUsableConnection();
      if (!connection) return;
      this.waiters.shift()?.resolve(connection);
    }
  }

  private serveNextWaiter(): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      this.acquire().then(waiter.resolve, waiter.reject);
    }
  }
}
