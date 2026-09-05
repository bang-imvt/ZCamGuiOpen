import { CameraHttpTransport, HttpCredentials } from './http-transport';
import { CameraNotifications } from './notifications';
import { CameraState, eventSettingKey } from './camera-state';
import { StreamControl } from './stream-control';
import { SettingsEngine } from './settings-engine';
import { CameraCredentials, CameraEvent } from '../shared/types';

export type CameraEventWithKeys = { event: CameraEvent; changedKeys: string[] };
type CameraEventListener = (update: CameraEventWithKeys) => void;

export class CameraClient {
  readonly http: CameraHttpTransport;
  readonly notifications: CameraNotifications;
  /** Single source of truth for setting values — the renderer only renders. */
  readonly state = new CameraState();
  readonly stream: StreamControl;
  readonly settings = new SettingsEngine(this);

  private readonly cameraEventListeners = new Set<CameraEventListener>();

  constructor(address: string, credentials?: CameraCredentials, forcedScheme?: string) {
    this.http = new CameraHttpTransport(address, credentials, undefined, forcedScheme);
    this.stream = new StreamControl(this.http, this.state);
    this.notifications = new CameraNotifications(address, credentials);
    // WS upgrade reuses the HTTP transport's Digest challenge/token state.
    this.notifications.handshakeHeaders = () => this.http.handshakeHeaders();
    // Every WS event marks the affected setting stale (so the next read is
    // fresh) and reaches the main process with the changed keys attached.
    this.notifications.onEvent((event) => {
      const key = eventSettingKey(event.payload);
      const changedKeys = key ? [key] : [];
      if (changedKeys.length) this.state.markStale(changedKeys);
      // Structured endpoints (stream_setting etc.) have no key — the stream
      // change event invalidates every cached stream resource.
      if (event.type === 'stream-settings-changed') this.state.markStaleResource('stream_setting:');
      const update: CameraEventWithKeys = { event, changedKeys };
      this.cameraEventListeners.forEach((listener) => listener(update));
    });
  }

  /** WS events (normalized) with the setting keys they invalidate. */
  onCameraEvent(listener: CameraEventListener): () => void {
    this.cameraEventListeners.add(listener);
    return () => this.cameraEventListeners.delete(listener);
  }

  /** UI progress for long-running background steps (login, browser fallback). */
  onProgress(listener: (message: string) => void): () => void {
    this.http.onProgress(listener);
    return () => this.http.onProgress(() => undefined);
  }

  /** Fetches one setting through the camera and caches it in the state store. */
  async fetchSetting(key: string) {
    const response = await this.http.get(`/ctrl/get?k=${encodeURIComponent(key)}`);
    this.state.applySettingResponse(key, response);
    return response;
  }

  /** Fetches a settings catalog batch and caches every entry. */
  async fetchCatalog(catalog: string) {
    const response = await this.http.get(`/ctrl/getbatch?catalog=${encodeURIComponent(catalog)}`);
    this.state.applyCatalogResponse(response);
    return response;
  }

  /** Writes a setting and immediately invalidates the cached value. */
  async writeSetting(key: string, value: string) {
    const response = await this.http.get<Record<string, unknown>>(`/ctrl/set?${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    if (Number(response?.code ?? 0) !== 0) {
      throw new Error(String(response?.desc ?? response?.msg ?? `Camera rejected ${key} (code ${response?.code})`));
    }
    this.state.markStale([key]);
    return response;
  }

  /** HTTP Digest login against /login/ — establishes the camera session. */
  login() { return this.http.login(); }

  /**
   * Full connection handshake: optional Digest login, /info + status + mode,
   * then the official https_on handling (an https-enabled camera moves the
   * whole session — including WebRTC signaling — to HTTPS even when http:80
   * answered first). Skipped when the user forced a scheme.
   */
  async connect(options: { credentials?: CameraCredentials; forcedScheme?: string; timeoutMs?: number }) {
    const timeoutMs = options.timeoutMs ?? 8_000;
    if (options.credentials) await this.login();
    const [info, status, mode] = await Promise.all([
      this.getInfo(timeoutMs),
      this.getStatus(timeoutMs),
      this.getMode(timeoutMs)
    ]);
    try {
      const httpsSetting = await this.fetchSetting('https_on') as Record<string, unknown> | undefined;
      const value = String(httpsSetting?.value ?? '').toLowerCase();
      if (/^(on|enable|enabled|true|1)$/.test(value) && !this.http.secure && options.forcedScheme !== 'http') {
        const switched = await this.http.preferHttps();
        if (!switched) console.log(`https_on is enabled but https:443 did not answer for ${this.http.address} — staying on http`);
      }
    } catch { /* setting unsupported on this firmware — keep current scheme */ }
    // Follow the scheme the transport negotiated for the WebSocket.
    this.notifications.secure = this.http.secure;
    return { info, status, mode, mjpegUrl: this.mjpegUrl() };
  }

  getInfo(timeoutMs?: number) { return this.http.get('/info', timeoutMs); }
  getMode(timeoutMs?: number) { return this.http.get('/ctrl/mode', timeoutMs); }
  getStatus(timeoutMs?: number) { return this.http.get('/camera_status', timeoutMs); }

  startRecording() { return this.http.get('/ctrl/rec?action=start'); }
  stopRecording() { return this.http.get('/ctrl/rec?action=stop'); }
  getRecordingStatus() { return this.http.get('/ctrl/rec?action=query'); }
  // Remaining record time in seconds — the record button is disabled at 0.
  getRecordingRemain() { return this.http.get('/ctrl/rec?action=remain'); }
  capturePhoto() { return this.http.get('/ctrl/still?action=cap'); }
  // Official record gate (controller.min.js): card present ⇔ code === 0.
  cardPresent() { return this.http.get('/ctrl/card?action=present'); }

  pingSession() { return this.http.get('/ctrl/session'); }
  /**
   * Quit is skipped entirely when the camera never answered — an unreachable
   * camera would burn 3 origins × timeout on the shared request queue and
   * delay the very next login/connect behind it.
   */
  quitSession() {
    if (!this.http.negotiated) return Promise.resolve(undefined);
    return this.http.get('/ctrl/session?action=quit', 4_000);
  }

  getSetting(key: string) {
    return this.http.get(`/ctrl/get?k=${encodeURIComponent(key)}`);
  }

  getCatalog(catalog: string) {
    return this.http.get(`/ctrl/getbatch?catalog=${encodeURIComponent(catalog)}`);
  }

  setSetting(key: string, value: string) {
    return this.http.get(`/ctrl/set?${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }

  listFolders() { return this.http.get('/DCIM/'); }
  listFiles(folder: string) { return this.http.get(`/DCIM/${encodeURIComponent(folder)}/`); }

  mjpegUrl() { return this.http.mediaUrl('/mjpeg_stream'); }

  private lens(action: string, speed?: number) {
    if (speed !== undefined && (!Number.isFinite(speed) || speed < 0 || speed > 100)) throw new Error(`Invalid lens speed: ${speed}`);
    const query = new URLSearchParams({ action });
    if (speed !== undefined) query.set('fspeed', String(Math.round(speed)));
    return this.http.get(`/ctrl/lens?${query.toString()}`);
  }

  focusNear(speed = 50) { return this.lens('focusnear', speed); }
  focusFar(speed = 50) { return this.lens('focusfar', speed); }
  focusStop() { return this.lens('focusstop'); }
  focusStatus() { return this.lens('f_status'); }
  zoomIn(speed = 50) { return this.lens('zoomin', speed); }
  zoomOut(speed = 50) { return this.lens('zoomout', speed); }
  zoomStop() { return this.lens('zoomstop'); }
  zoomStatus() { return this.lens('z_status'); }
  onePushAf() { return this.http.get('/ctrl/af'); }
  getRoi() { return this.http.get('/ctrl/af?action=query'); }
  // The camera expects the ROI center on a 0-1000 scale (the reference web UI
  // sends offset/width*1000); values outside that range are invalid.
  updateRoiCenter(x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1000 || y < 0 || y > 1000) throw new Error('ROI coordinates must be between 0 and 1000');
    return this.http.get(`/ctrl/af?action=update_roi_center&x=${encodeURIComponent(String(x))}&y=${encodeURIComponent(String(y))}`);
  }
}
