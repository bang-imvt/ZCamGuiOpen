import WebSocket from 'ws';
import { session } from 'electron';
import { CameraCredentials, CameraEvent } from '../shared/types';

export type NotificationState = 'connecting' | 'live' | 'reconnecting' | 'closed';

type NotificationListener = (event: CameraEvent) => void;
// State may carry a diagnostic suffix (e.g. "reconnecting (close 1006)").
type StateListener = (state: string) => void;

export class CameraNotifications {
  /** Set before connect(); follows the HTTP transport's negotiated scheme. */
  secure = false;

  /**
   * Supplies auth headers for the upgrade request (Digest Authorization
   * computed from the HTTP transport's cached challenge, plus X-AuthToken).
   * The camera may also accept the HTTP session cookie — both are sent.
   */
  handshakeHeaders?: () => Record<string, string> | undefined;

  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private handshakeTimer?: NodeJS.Timeout;
  private closed = false;
  private reconnectDelay = 1_000;
  private lastSocketError: string | undefined;
  private readonly eventListeners = new Set<NotificationListener>();
  private readonly stateListeners = new Set<StateListener>();

  constructor(private readonly address: string, private readonly credentials?: CameraCredentials) {}

  connect(): void {
    this.closed = false;
    void this.open();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.reconnectTimer = undefined;
    this.handshakeTimer = undefined;
    this.socket?.close();
    this.socket = undefined;
    this.emitState('closed');
  }

  onEvent(listener: NotificationListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private async open(): Promise<void> {
    if (this.closed) return;
    this.emitState('connecting');
    const protocol = this.secure ? 'wss' : 'ws';
    // The WS server sits behind the same auth as HTTP — send the Digest
    // Authorization from the HTTP transport's cached challenge, the auth
    // token, and the session cookie on the upgrade request.
    const headers: Record<string, string> = {
      ...this.handshakeHeaders?.()
    };
    if (this.credentials) {
      headers.authorization ??= `Basic ${Buffer.from(`${this.credentials.username}:${this.credentials.password}`).toString('base64')}`;
    }
    try {
      const cookies = await session.defaultSession.cookies.get({});
      const relevant = cookies.filter((cookie) => {
        const domain = (cookie.domain ?? '').replace(/^\./, '');
        return domain === this.address;
      });
      if (relevant.length) headers.cookie = relevant.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    } catch { /* cookie store unavailable — proceed without it */ }

    // The camera's HTTPS certificate is self-signed. The `ws` module runs on
    // Node's TLS stack, which ignores the Chromium certificate-verify bypass
    // (session.setCertificateVerifyProc) that the HTTP path relies on — without
    // this a wss:// notifications socket to an https_on camera dies with
    // "self signed certificate" (close 1006) in an endless reconnect loop.
    // This socket only ever targets the connected camera host, so it is
    // consistent with the app's existing trust model.
    const socket = new WebSocket(`${protocol}://${formatAddress(this.address)}:81/`, {
      headers,
      ...(this.secure ? { rejectUnauthorized: false } : {})
    });
    this.socket = socket;
    this.handshakeTimer = setTimeout(() => {
      if (this.socket !== socket || this.closed) return;
      this.lastSocketError = 'notification handshake timeout';
      socket.terminate();
    }, 10_000);

    socket.on('open', () => {
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
      this.reconnectDelay = 1_000;
      this.lastSocketError = undefined;
      this.emitState('live');
    });
    socket.on('message', (data) => this.handleMessage(data.toString()));
    // Keep the failure reason — repeated close/error cycles are otherwise
    // invisible ("reconnecting" with no cause).
    socket.on('error', (error) => { this.lastSocketError = error?.message ?? String(error); });
    socket.on('close', (code, reason) => {
      if (this.socket !== socket) return;
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
      this.socket = undefined;
      if (this.closed) return;
      const detail = [
        code ? `close ${code}` : undefined,
        reason?.length ? String(reason) : undefined,
        this.lastSocketError
      ].filter(Boolean).join(' — ');
      this.emitState(detail ? `reconnecting (${detail})` : 'reconnecting');
      this.reconnectTimer = setTimeout(() => this.open(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8_000);
    });
  }

  private handleMessage(raw: string): void {
    try {
      const payload = JSON.parse(raw) as Record<string, unknown>;
      const what = typeof payload.what === 'string' ? payload.what : 'unknown';
      this.eventListeners.forEach((listener) => listener({
        type: normalizeEventType(what),
        payload
      }));
    } catch {
      // Ignore malformed notifications; HTTP refresh remains authoritative.
    }
  }

  private emitState(state: string): void {
    this.stateListeners.forEach((listener) => listener(state));
  }
}

function normalizeEventType(what: string): string {
  const types: Record<string, string> = {
    camera_status: 'camera-status-changed',
    RecStarted: 'recording-started',
    RecStoped: 'recording-stopped',
    RecUpdateDur: 'recording-duration',
    RecUpdateRemain: 'recording-remaining',
    RecordingFile: 'recording-file',
    ModeChanged: 'mode-changed',
    TempUpdate: 'temperature',
    UpdateStreamSetting: 'stream-settings-changed',
    ConfigChanged: 'config-changed',
    UpdateAfArea: 'af-area-changed',
    basicInfo: 'basic-info',
    Shutdown: 'camera-shutdown',
    hb: 'heartbeat'
  };
  return types[what] ?? 'unknown';
}

function formatAddress(address: string): string {
  return address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;
}
