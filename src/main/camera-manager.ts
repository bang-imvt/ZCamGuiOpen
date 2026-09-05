import { CameraClient, CameraEventWithKeys } from '../camera/camera-client';
import { CameraCredentials, CameraCandidate } from '../shared/types';

type Session = {
  key: string;
  client: CameraClient;
  candidate: CameraCandidate;
  credentials?: CameraCredentials;
  forcedScheme?: string;
  result?: { info: unknown; status: unknown; mode: unknown; mjpegUrl: string };
  connecting?: Promise<{ info: unknown; status: unknown; mode: unknown; mjpegUrl: string }>;
  removeCameraListener: () => void;
  removeStateListener: () => void;
};

export type ManagedEvent = { address: string; update: CameraEventWithKeys };
export type ManagedState = { address: string; state: string };
export type ManagedProgress = { address: string; message: string };
export type ManagedSnapshot = { address: string; snapshot: import('../camera/settings-engine').SettingsSnapshot };

function key(address: string): string { return String(address ?? '').trim().toLowerCase(); }

function credentialsEqual(a?: CameraCredentials, b?: CameraCredentials): boolean {
  return a?.username === b?.username && a?.password === b?.password;
}

/** Owns reusable per-camera clients while exposing one selected session. */
export class CameraManager {
  private readonly sessions = new Map<string, Session>();
  private activeKey?: string;
  private generation = 0;
  private selectionIntent = 0;
  private eventListener?: (event: ManagedEvent) => void;
  private stateListener?: (state: ManagedState) => void;
  private progressListener?: (progress: ManagedProgress) => void;
  private snapshotListener?: (update: ManagedSnapshot) => void;

  onEvent(listener: (event: ManagedEvent) => void): void { this.eventListener = listener; }
  onState(listener: (state: ManagedState) => void): void { this.stateListener = listener; }
  onProgress(listener: (progress: ManagedProgress) => void): void { this.progressListener = listener; }
  onSnapshot(listener: (update: ManagedSnapshot) => void): void { this.snapshotListener = listener; }

  get active(): CameraClient | undefined { return this.activeKey ? this.sessions.get(this.activeKey)?.client : undefined; }
  get activeAddress(): string | undefined { return this.activeKey ? this.sessions.get(this.activeKey)?.client.http.address : undefined; }

  async connect(candidate: CameraCandidate, credentials?: CameraCredentials, forcedScheme?: string, timeoutMs = 8_000) {
    const sessionKey = key(candidate.address);
    let session = this.sessions.get(sessionKey);
    if (session?.result && credentialsEqual(session.credentials, credentials) && session.forcedScheme === forcedScheme) {
      this.activeKey = sessionKey;
      return session.result;
    }
    if (session && (session.credentials !== undefined || credentials !== undefined || session.forcedScheme !== forcedScheme)) {
      // Authentication/protocol options are part of the session identity; do
      // not reuse a connected client configured with different options.
      this.disposeSession(sessionKey, true);
      session = undefined;
    }
    if (!session) {
      const client = new CameraClient(candidate.address, credentials, forcedScheme);
      session = {
        key: sessionKey,
        client,
        candidate,
        credentials,
        forcedScheme,
        removeCameraListener: () => undefined,
        removeStateListener: () => undefined
      };
      session.removeCameraListener = client.onCameraEvent((update) => this.eventListener?.({ address: client.http.address, update }));
      session.removeStateListener = client.notifications.onState((state) => this.stateListener?.({ address: client!.http.address, state }));
      client.onProgress((message) => this.progressListener?.({ address: client.http.address, message }));
      client.settings.onSnapshot((snapshot) => this.snapshotListener?.({ address: client.http.address, snapshot }));
      this.sessions.set(sessionKey, session);
    }
    if (session.connecting) return session.connecting;
    const connecting = session.client.connect({ credentials, forcedScheme, timeoutMs });
    session.connecting = connecting;
    try {
      const result = await connecting;
      session.result = result;
      this.activeKey = sessionKey;
      session.client.notifications.secure = session.client.http.secure;
      session.client.notifications.connect();
      return result;
    } catch (error) {
      // Failed sessions are retained only as objects while the caller decides
      // whether to retry; they never replace the currently active session.
      this.disposeSession(sessionKey, false);
      throw error;
    } finally {
      if (session.connecting === connecting) session.connecting = undefined;
    }
  }

  activate(address: string): Session['result'] | undefined {
    const session = this.sessions.get(key(address));
    if (!session?.result) return undefined;
    this.activeKey = session.key;
    return session.result;
  }

  getClient(): CameraClient | undefined { return this.active; }

  async disconnect(address?: string): Promise<void> {
    if (!address) { this.generation += 1; this.activeKey = undefined; return this.closeAll(); }
    const sessionKey = key(address);
    const wasActive = this.activeKey === sessionKey;
    this.disposeSession(sessionKey, true);
    if (wasActive) this.activeKey = undefined;
  }

  async closeAll(): Promise<void> {
    this.generation += 1;
    for (const sessionKey of [...this.sessions.keys()]) this.disposeSession(sessionKey, true);
    this.activeKey = undefined;
  }

  private disposeSession(sessionKey: string, quit: boolean): void {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    session.removeCameraListener();
    session.removeStateListener();
    session.client.notifications.close();
    this.sessions.delete(sessionKey);
    if (quit) void session.client.quitSession().catch(() => undefined);
  }
}
