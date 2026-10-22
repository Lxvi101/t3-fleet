// Minimal client for t3code's WebSocket RPC: Effect RPC messages serialized as JSON
// (RpcSerialization.layerJson). Only streaming subscriptions are needed here.

type Exit = { _tag: "Success"; value?: unknown } | { _tag: "Failure"; cause: unknown[] };

interface StreamHandlers {
  onValues(values: unknown[]): void;
  onExit(exit: Exit): void;
}

const PING_EVERY_MS = 10_000;
const PONG_TIMEOUT_MS = 30_000;

export class RpcSocket {
  private nextId = 1;
  private readonly streams = new Map<string, StreamHandlers>();
  private lastPongAt = Date.now();
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  private constructor(
    private readonly ws: WebSocket,
    private readonly onClose: (reason: string) => void,
  ) {
    ws.onmessage = (event) => this.receive(String(event.data));
    ws.onclose = (event) => this.shutdown(`socket closed (${event.code}${event.reason ? ` ${event.reason}` : ""})`);
    ws.onerror = () => this.shutdown("socket error");
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPongAt > PONG_TIMEOUT_MS) return this.shutdown("ping timeout");
      this.send({ _tag: "Ping" });
    }, PING_EVERY_MS);
  }

  static open(url: string, onClose: (reason: string) => void): Promise<RpcSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("websocket open timed out"));
      }, 15_000);
      ws.onopen = () => {
        clearTimeout(timeout);
        resolve(new RpcSocket(ws, onClose));
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("websocket failed to open"));
      };
    });
  }

  /** Starts a streaming RPC. Returns a function that interrupts it. */
  stream(tag: string, payload: unknown, handlers: StreamHandlers): () => void {
    const id = String(this.nextId++);
    this.streams.set(id, handlers);
    this.send({ _tag: "Request", id, tag, payload, headers: [] });
    return () => {
      if (!this.streams.delete(id)) return;
      this.send({ _tag: "Interrupt", requestId: id, interruptors: [] });
    };
  }

  close() {
    this.shutdown("closed by collector");
    try {
      this.ws.close();
    } catch {}
  }

  private send(message: unknown) {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  private receive(raw: string) {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    switch (message?._tag) {
      case "Pong":
        this.lastPongAt = Date.now();
        return;
      case "Ping":
        this.send({ _tag: "Pong" });
        return;
      case "Chunk": {
        const requestId = String(message.requestId);
        // The server withholds further chunks until each one is acknowledged.
        this.send({ _tag: "Ack", requestId });
        this.streams.get(requestId)?.onValues(Array.isArray(message.values) ? message.values : []);
        return;
      }
      case "Exit": {
        const requestId = String(message.requestId);
        const handlers = this.streams.get(requestId);
        this.streams.delete(requestId);
        handlers?.onExit(message.exit);
        return;
      }
      case "Defect":
      case "ClientProtocolError":
        this.shutdown(`protocol error: ${JSON.stringify(message).slice(0, 300)}`);
        return;
    }
  }

  private shutdown(reason: string) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    const streams = [...this.streams.values()];
    this.streams.clear();
    for (const handlers of streams) handlers.onExit({ _tag: "Failure", cause: [{ _tag: "Die", defect: reason }] });
    this.onClose(reason);
  }
}

export function describeExit(exit: Exit | undefined): string {
  if (!exit || exit._tag === "Success") return "stream ended";
  const first = (exit.cause as any[])?.[0];
  const error = first?.error ?? first?.defect ?? first;
  if (typeof error === "string") return error;
  return error?.message ?? error?.code ?? error?._tag ?? JSON.stringify(error ?? exit).slice(0, 200);
}
