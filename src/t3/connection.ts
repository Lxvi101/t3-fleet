import { readToken, resolveBaseUrl, type ServerConfig } from "../config.ts";
import type { ServerStatus } from "../model.ts";
import {
  applyConfigItem,
  applyShellItem,
  emptyConfig,
  applyThreadItem,
  emptyDetail,
  emptyShell,
  parseDescriptor,
  PATHS,
  RPC,
  SUPPORTED_PROTOCOL_VERSIONS,
  wsUrl,
  type DetailChange,
  type Descriptor,
  type ShellChange,
  type ThreadDetailState,
} from "./adapter.ts";
import { describeExit, RpcSocket } from "./rpc.ts";

export interface ConnectionListener {
  status(connection: ServerConnection): void;
  shell(connection: ServerConnection, change: ShellChange): void;
  detail(connection: ServerConnection, threadId: string, change: DetailChange): void;
  usage(connection: ServerConnection): void;
}

export interface DetailStream {
  state: ThreadDetailState;
  live: boolean;
  cancel: (() => void) | null;
  /** Earliest time a failed subscription is retried. */
  retryAfter: number;
}

class ConnectError extends Error {
  constructor(
    readonly status: ServerStatus,
    message: string,
  ) {
    super(message);
  }
}

const RETRY_MS: Partial<Record<ServerStatus, number>> = { unauthorized: 60_000, incompatible: 300_000 };
const DETAIL_RETRY_MS = 60_000;

/** One read-only connection to one t3code environment, reconnecting forever. */
export class ServerConnection {
  status: ServerStatus = "connecting";
  statusDetail: string | null = null;
  descriptor: Descriptor | null = null;
  baseUrl: string | null = null;
  connectedAt: string | null = null;
  lastSeenAt: string | null = null;
  /** True once the shell stream has delivered its initial state on this socket. */
  synced = false;
  readonly shell = emptyShell();
  readonly details = new Map<string, DetailStream>();
  readonly usageState = emptyConfig();

  private socket: RpcSocket | null = null;
  private stopped = false;
  private failures = 0;
  private wakeup: (() => void) | null = null;

  constructor(
    readonly config: ServerConfig,
    private readonly listener: ConnectionListener,
  ) {}

  get id() {
    return this.config.id;
  }

  get label() {
    return this.config.label ?? this.descriptor?.label ?? this.config.id;
  }

  start() {
    void this.loop();
  }

  stop() {
    this.stopped = true;
    this.socket?.close();
    this.wakeup?.();
  }

  /** Attach detail streams for exactly these threads (detached ones keep their last state). */
  setDetailThreads(wanted: Set<string>) {
    for (const [threadId, stream] of this.details) {
      if (stream.live && !wanted.has(threadId)) {
        stream.cancel?.();
        stream.cancel = null;
        stream.live = false;
        this.listener.detail(this, threadId, { type: "other" });
      }
    }
    if (!this.socket || !this.synced) return;
    const now = Date.now();
    for (const threadId of wanted) {
      const existing = this.details.get(threadId);
      if (existing?.live || (existing && existing.retryAfter > now)) continue;
      this.subscribeThread(threadId, existing);
    }
  }

  private subscribeThread(threadId: string, existing: DetailStream | undefined) {
    const socket = this.socket!;
    const stream: DetailStream = existing ?? { state: emptyDetail(), live: false, cancel: null, retryAfter: 0 };
    this.details.set(threadId, stream);
    stream.live = true;
    stream.state.synced = false;
    const payload: Record<string, unknown> = { threadId, requestCompletionMarker: true, acceptBoundedSnapshot: true };
    if (stream.state.sequence !== null) payload.afterSequence = stream.state.sequence;
    stream.cancel = socket.stream(RPC.subscribeThread, payload, {
      onValues: (values) => {
        this.lastSeenAt = new Date().toISOString();
        for (const value of values) {
          const change = applyThreadItem(stream.state, value);
          if (change) this.listener.detail(this, threadId, change);
        }
      },
      onExit: (exit) => {
        if (socket !== this.socket || !stream.live) return;
        stream.live = false;
        stream.cancel = null;
        stream.retryAfter = Date.now() + DETAIL_RETRY_MS;
        console.warn(`[${this.id}] thread ${threadId} stream ended: ${describeExit(exit)}`);
        this.listener.detail(this, threadId, { type: "other" });
      },
    });
  }

  private async loop() {
    while (!this.stopped) {
      try {
        await this.connectOnce();
        this.failures = 0;
      } catch (error) {
        const status = error instanceof ConnectError ? error.status : "offline";
        this.setStatus(status, error instanceof Error ? error.message : String(error));
        this.failures++;
      }
      if (this.stopped) return;
      const delay = RETRY_MS[this.status] ?? Math.min(30_000, 1000 * 2 ** Math.min(this.failures, 5));
      await new Promise<void>((resolve) => {
        this.wakeup = resolve;
        setTimeout(resolve, delay);
      });
    }
  }

  /** Resolves when an established connection closes; rejects if it cannot be established. */
  private async connectOnce() {
    this.setStatus("connecting", null);
    const baseUrl = resolveBaseUrl(this.config);
    if (!baseUrl) throw new ConnectError("offline", "No URL (is the local server running?)");
    this.baseUrl = baseUrl;

    const descriptorResponse = await fetch(new URL(PATHS.descriptor, baseUrl), { signal: AbortSignal.timeout(8000) }).catch(
      (error) => {
        throw new ConnectError("offline", `Unreachable: ${error.message}`);
      },
    );
    if (!descriptorResponse.ok) throw new ConnectError("offline", `Descriptor HTTP ${descriptorResponse.status}`);
    this.descriptor = parseDescriptor(await descriptorResponse.json());
    const protocol = this.descriptor.protocolVersion;
    if (protocol === null || !SUPPORTED_PROTOCOL_VERSIONS.includes(protocol)) {
      throw new ConnectError(
        "incompatible",
        `Server speaks orchestration protocol ${protocol ?? "unknown"}; this monitor supports ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
      );
    }

    const token = readToken(this.config);
    if (!token) throw new ConnectError("unauthorized", "No token configured");
    const ticketResponse = await fetch(new URL(PATHS.wsTicket, baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (ticketResponse.status === 401 || ticketResponse.status === 403) {
      throw new ConnectError("unauthorized", `Token rejected (HTTP ${ticketResponse.status})`);
    }
    if (!ticketResponse.ok) throw new ConnectError("offline", `Ticket HTTP ${ticketResponse.status}`);
    const { ticket } = (await ticketResponse.json()) as { ticket: string };

    let closed!: (reason: string) => void;
    const whenClosed = new Promise<string>((resolve) => (closed = resolve));
    const socket = await RpcSocket.open(wsUrl(baseUrl, protocol, ticket), (reason) => closed(reason));
    this.socket = socket;
    this.synced = false;

    const shellPayload: Record<string, unknown> = { requestCompletionMarker: true };
    if (this.shell.sequence !== null) shellPayload.afterSequence = this.shell.sequence;
    socket.stream(RPC.subscribeShell, shellPayload, {
      onValues: (values) => {
        this.lastSeenAt = new Date().toISOString();
        for (const value of values) {
          const change = applyShellItem(this.shell, value);
          if (!change) continue;
          if (change.type === "synchronized" && !this.synced) {
            this.synced = true;
            this.connectedAt = new Date().toISOString();
            this.setStatus("connected", null);
          }
          this.listener.shell(this, change);
        }
      },
      onExit: (exit) => {
        if (socket === this.socket) closed(`shell stream ended: ${describeExit(exit)}`);
      },
    });

    // Usage limits ride on the server config stream; older servers without it just report none.
    socket.stream(RPC.subscribeServerConfig, { usageLimitSources: true }, {
      onValues: (values) => {
        let changed = false;
        for (const value of values) changed = applyConfigItem(this.usageState, value) || changed;
        if (changed) this.listener.usage(this);
      },
      onExit: (exit) => {
        if (socket === this.socket) console.warn(`[${this.id}] config stream ended: ${describeExit(exit)}`);
      },
    });

    const reason = await whenClosed;
    this.socket = null;
    this.synced = false;
    socket.close();
    for (const stream of this.details.values()) {
      stream.live = false;
      stream.cancel = null;
    }
    this.setStatus("offline", reason);
  }

  private setStatus(status: ServerStatus, detail: string | null) {
    if (this.status === status && this.statusDetail === detail) return;
    this.status = status;
    this.statusDetail = detail;
    this.listener.status(this);
  }
}
