import type { DashboardEvent } from '../types.ts';

export interface EventWriter {
  write(chunk: string): void;
  onClose(callback: () => void): void;
}

export interface EventHubOptions {
  /** How many recent events to keep for reconnect replay. */
  bufferSize?: number;
  heartbeatMs?: number;
}

/**
 * Server-sent-event fan-out for run telemetry.
 *
 * A monotonically increasing `seq` lets a reconnecting browser ask for
 * everything it missed (`Last-Event-ID`), which matters because agent runs are
 * long and a dropped connection must not silently hide progress.
 */
export class EventHub {
  private readonly buffer: DashboardEvent[] = [];
  private readonly clients = new Set<{ id: number; write: (chunk: string) => void }>();
  private readonly bufferSize: number;
  private readonly heartbeatMs: number;
  private seq = 0;
  private nextClientId = 1;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(options: EventHubOptions = {}) {
    this.bufferSize = options.bufferSize ?? 1000;
    this.heartbeatMs = options.heartbeatMs ?? 20_000;
  }

  /** Assign a sequence number, buffer the event, and push it to every client. */
  emit(event: Omit<DashboardEvent, 'seq'>): DashboardEvent {
    const full: DashboardEvent = { ...event, seq: ++this.seq };
    this.buffer.push(full);
    if (this.buffer.length > this.bufferSize) this.buffer.splice(0, this.buffer.length - this.bufferSize);
    const frame = formatEvent(full);
    for (const client of this.clients) {
      try {
        client.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
    return full;
  }

  /** Replay a bounded history, e.g. when a browser opens the dashboard. */
  history(sinceSeq = 0, runId?: string): DashboardEvent[] {
    return this.buffer.filter(
      (event) => event.seq > sinceSeq && (runId === undefined || event.runId === runId),
    );
  }

  get lastSeq(): number {
    return this.seq;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Attach a writer; returns a detach function. */
  subscribe(writer: EventWriter, sinceSeq = 0): () => void {
    const client = { id: this.nextClientId++, write: writer.write };
    this.clients.add(client);
    writer.write(`retry: 3000\n\n`);
    for (const event of this.history(sinceSeq)) writer.write(formatEvent(event));
    writer.write(`event: ready\ndata: ${JSON.stringify({ lastSeq: this.seq })}\n\n`);
    this.startHeartbeat();
    let detached = false;
    const detach = (): void => {
      if (detached) return;
      detached = true;
      this.clients.delete(client);
      if (this.clients.size === 0) this.stopHeartbeat();
    };
    writer.onClose(detach);
    return detach;
  }

  private startHeartbeat(): void {
    if (this.heartbeat || this.heartbeatMs <= 0) return;
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        try {
          client.write(`: ping ${Date.now()}\n\n`);
        } catch {
          this.clients.delete(client);
        }
      }
      if (this.clients.size === 0) this.stopHeartbeat();
    }, this.heartbeatMs);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeat) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  close(): void {
    this.stopHeartbeat();
    for (const client of this.clients) {
      try {
        client.write('event: bye\ndata: {}\n\n');
      } catch {
        /* client already gone */
      }
    }
    this.clients.clear();
  }
}

function formatEvent(event: DashboardEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}