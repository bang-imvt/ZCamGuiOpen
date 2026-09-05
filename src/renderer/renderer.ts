import { SETTINGS_GROUPS, DEPENDENT_GROUPS, BOOLEAN_PAIRS, HUD_KEYS } from '../shared/settings-schema.js';
import type { GroupDef, SettingDef } from '../shared/settings-schema.js';
import type { GalleryFile, GalleryFolder } from '../shared/gallery.js';

type Candidate = { id: string; name: string; address: string; reachable: boolean; probeError?: string };
declare global {
  interface Window {
    cameraApp: any;
  }
}

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
let selected: Candidate | undefined;
let displayAddress: string | undefined;
const removedAddresses = new Set<string>();

// ---------------------------------------------------------------------------
// Debug log
// ---------------------------------------------------------------------------

function log(message: string): void {
  const element = $('#debug-log');
  element.textContent = `${element.textContent ? `${element.textContent}\n` : ''}${new Date().toLocaleTimeString()} ${message}`.slice(-20_000);
}
function text(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value) ?? '-'; }

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function safe(value: string): string { return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); }

/** Canonical host key used to identify the same camera across URL/IP input forms. */
function addressKey(raw: string): string {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`);
    return parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return value.replace(/^https?:\/\//i, '').split('/')[0].replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  }
}

function page(name: string): void { document.body.dataset.page = name; document.querySelectorAll('.page').forEach((item) => item.classList.toggle('active', item.id === name)); document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', (item as HTMLElement).dataset.page === name)); if (name === 'gallery') void refreshLibrary(); }
// The status pill was removed — connection problems surface in the scan
// status line and the debug panel instead.
function field(response: any, keys: string[]): unknown {
  if (!response || typeof response !== 'object') return undefined;
  for (const key of keys) if (key in response) return response[key];
  return undefined;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function scan(): Promise<void> {
  const scanButton = $<HTMLButtonElement>('#scan'); scanButton.disabled = true; scanButton.textContent = 'Scanning...';
  $('#scan-status').textContent = 'Scanning mDNS on the selected interface...';
  try {
    const cameras = await window.cameraApp.discover(10_000, $<HTMLSelectElement>('#interface').value || undefined) as Candidate[];
    discoveredCameras = cameras.filter((camera) => !removedAddresses.has(addressKey(camera.address)));
    renderCameraRail();
    // Connect stays enabled even when the probe failed (e.g. auth or HTTPS-only
    // firmware); the connect attempt retries the camera live.
    // Login UI appears when the probe detected auth — and, as a fallback,
    // automatically whenever a connect attempt is rejected with 401 (the
    // probe cannot catch every auth configuration).
    renderCameraList();
    if (cameras.length) $('#scan-status').textContent = `mDNS scan found ${cameras.length} camera(s).`;
  } catch (error) {
    $('#scan-status').textContent = `Scan failed: ${String(error)}`;
    log(`mDNS scan error: ${String(error)}`);
  } finally {
    scanButton.disabled = false;
    scanButton.textContent = 'Scan 10 seconds';
  }
}

function renderCameraList(): void {
  const cameras = discoveredCameras;
  // The "+" box leads the list (mDNS misses are common — manual entry stays
  // one click away), aligned like the camera rows below it.
  const items = [`<div class="add-camera-box" id="add-camera-box"><button id="add-camera-toggle" title="Add camera manually" aria-label="Add camera manually">+</button><span>Add camera manually</span><div class="add-camera-form hidden" id="add-camera-form"><input id="manual-ip" placeholder="Camera IP, e.g. 192.168.1.100" autocomplete="off" spellcheck="false"><button id="manual-add" class="secondary">Add</button></div></div>`];
  for (const [index, camera] of cameras.entries()) {
    // Scheme override per row: Auto lets the transport negotiate (and honor
    // https_on / 503 hints); HTTP/HTTPS force it.
    const scheme = schemeOverrides.get(addressKey(camera.address)) ?? '';
    items.push(`<div class="camera-item" data-address="${safe(camera.address)}"><div><strong>${safe(camera.name)}</strong><span>${safe(camera.address)}:80 ${camera.reachable ? (camera.probeError ? `· ${safe(camera.probeError)}` : '· API ready') : `· Not available (${safe(camera.probeError ?? 'no response')})`}</span></div><div class="camera-actions"><select class="scheme-select" data-scheme="${index}" title="Force HTTP or HTTPS"><option value=""${scheme === '' ? ' selected' : ''}>Auto</option><option value="http"${scheme === 'http' ? ' selected' : ''}>HTTP</option><option value="https"${scheme === 'https' ? ' selected' : ''}>HTTPS</option></select><button data-index="${index}">Connect</button><button class="camera-remove" data-remove-index="${index}" title="Remove camera from scan results" aria-label="Remove camera from scan results">×</button></div></div>`);
  }
  $('#camera-list').innerHTML = items.join('');
  // Scheme override selects (Auto / HTTP / HTTPS), kept per address so they
  // survive re-renders and apply to every connect path.
  $('#camera-list').querySelectorAll<HTMLSelectElement>('.scheme-select').forEach((select) => {
    const address = cameras[Number(select.dataset.scheme)]?.address;
    select.addEventListener('change', () => {
      if (!address) return;
      const key = addressKey(address);
      if (select.value) schemeOverrides.set(key, select.value as 'http' | 'https');
      else schemeOverrides.delete(key);
    });
  });
  // Bind each button to its camera object by position — avoids fragile
  // id-matching through escaped HTML attributes.
  $('#camera-list').querySelectorAll<HTMLButtonElement>('[data-index]').forEach((button) => {
    const camera = cameras[Number(button.dataset.index)];
    button.addEventListener('click', () => maybeConnect(camera));
  });
  $('#camera-list').querySelectorAll<HTMLButtonElement>('[data-remove-index]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const index = Number(button.dataset.removeIndex);
      const camera = discoveredCameras[index];
      if (!camera) return;
      const key = addressKey(camera.address);
      removedAddresses.add(key);
      discoveredCameras.splice(index, 1);
      schemeOverrides.delete(key);
      rememberedCredentials.delete(key);
      if (pendingSwitch && addressKey(pendingSwitch.camera.address) === key) pendingSwitch = undefined;
      const wasActive = !!selected && addressKey(selected.address) === key;
      if (wasActive) {
        selected = undefined;
        displayAddress = undefined;
        railActiveAddress = undefined;
        stopPreview();
      }
      void window.cameraApp.disconnect?.(camera.address).catch((error: unknown) => log(`Removed camera cleanup failed: ${String(error)}`));
      renderCameraList();
      renderCameraRail();
      $('#scan-status').textContent = `${camera.address} removed from scan results.`;
    });
  });
  // Add-camera box (rebuilt with the list, so rebind every render).
  $('#add-camera-toggle').addEventListener('click', () => {
    $('#add-camera-form').classList.toggle('hidden');
    if (!$('#add-camera-form').classList.contains('hidden')) $('#manual-ip').focus();
  });
  $('#manual-add').addEventListener('click', () => void addManualCamera());
  $('#manual-ip').addEventListener('keydown', (event) => { if ((event as KeyboardEvent).key === 'Enter') void addManualCamera(); });
}

/** Manual entry for cameras mDNS cannot see: probe /info, then list the result. */
async function addManualCamera(): Promise<void> {
  const input = $<HTMLInputElement>('#manual-ip');
  const button = $<HTMLButtonElement>('#manual-add');
  // Accept a bare IP or a pasted URL (scheme/port stripped).
  const host = input.value.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  if (!host) { $('#scan-status').textContent = 'Enter an IP address to add a camera manually.'; return; }
  if (!/^[a-zA-Z0-9._-]+$/.test(host)) { $('#scan-status').textContent = `"${host}" is not a valid IP or hostname.`; return; }
  if (discoveredCameras.some((item) => addressKey(item.address) === addressKey(host))) {
    $('#scan-status').textContent = `${host} is already in the scan results.`;
    return;
  }
  button.disabled = true; button.textContent = 'Checking...';
  $('#scan-status').textContent = `Checking ${host} for a camera control API...`;
  try {
    const result = await window.cameraApp.probeAddress(host) as { reachable: boolean; name?: string; probeError?: string };
    const candidate: Candidate = {
      id: `manual-${host}`,
      name: result.name?.trim() || host,
      address: host,
      reachable: result.reachable,
      probeError: result.probeError
    };
    if (!discoveredCameras.some((item) => item.address === candidate.address)) discoveredCameras.push(candidate);
    renderCameraList();
    renderCameraRail();
    $('#scan-status').textContent = result.reachable
      ? `${candidate.address} added — control API available.`
      : `${candidate.address} added but NOT available: ${result.probeError ?? 'no response'}`;
    input.value = '';
    $('#add-camera-form').classList.add('hidden');
  } catch (error) {
    $('#scan-status').textContent = `Manual probe of ${host} failed: ${String(error)}`;
  } finally {
    button.disabled = false;
    button.textContent = 'Add';
  }
}

// ---- Live preview -------------------------------------------------------
// Mirrors the official web UI: newer firmware streams via WebRTC (embedded
// webrtc-streamer on port 8000/8443, source rtsp://127.0.0.1/live_h264);
// older firmware serves <img src="/mjpeg_stream">. We try WebRTC first,
// then MJPEG on both schemes — always showing status instead of a blank box.
type PreviewStep = { kind: 'webrtc'; server: string } | { kind: 'mjpeg'; url: string };

let previewSteps: PreviewStep[] = [];
let previewStepIndex = 0;
let previewConnected = false;
let previewTimer: number | undefined;
let webrtcPreview: CameraWebRtc | null = null;
let mjpegStream: MjpegStream | null = null;
let previewGeneration = 0;
// Set by probeCameraStreamPage when the camera's own web page streams via an
// <img> — grounds for skipping WebRTC steps on later retry loops.
let probeSawImgStream = false;

class CameraWebRtc {
  private pc: RTCPeerConnection | null = null;
  private readonly peerid = Math.random();
  private earlyCandidates: RTCIceCandidateInit[] = [];

  constructor(
    private readonly server: string,
    private readonly video: HTMLVideoElement,
    private readonly onConnected: () => void,
    private readonly onFailed: (why: string) => void
  ) {}

  // Signaling goes through the main process: the page is file://-origin and
  // cannot fetch http://<camera> directly (CORS/mixed content).
  private async signal(path: string, method?: string, body?: string): Promise<unknown> {
    const response = await window.cameraApp.webrtcRequest({ url: `${this.server}${path}`, method, body });
    if (!response.ok) {
      // status 0 means a network-level failure — the error text (reset,
      // TLS, refused...) is the only way to tell why the camera refused us.
      throw new Error(`${path} HTTP ${response.status}${response.text ? ` — ${String(response.text).slice(0, 200)}` : ''}`);
    }
    try { return JSON.parse(response.text) as unknown; } catch { return response.text; }
  }

  async connect(): Promise<void> {
    // 1. ICE servers from the camera's embedded webrtc-streamer.
    const config = await this.signal('/api/getIceServers') as { iceServers?: RTCIceServer[] };
    log(`WebRTC: ${this.server} signaling ok (iceServers: ${config.iceServers?.length ?? 0})`);
    // 2. Peer connection.
    const pc = new RTCPeerConnection({ iceServers: config.iceServers ?? [] });
    this.pc = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.ontrack = (event) => {
      if (this.video.srcObject !== event.streams[0]) this.video.srcObject = event.streams[0];
      void this.video.play().catch(() => undefined);
    };
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (state === 'connected') this.onConnected();
      else if (state === 'failed' || state === 'closed') this.onFailed(state);
      else if (state === 'new') void this.pollCandidates();
    };
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      if (pc.remoteDescription) void this.pushCandidate(event.candidate);
      else this.earlyCandidates.push(event.candidate.toJSON());
    };
    // 3. Offer/answer exchange.
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const callUrl = `/api/call?peerid=${this.peerid}` +
      `&url=${encodeURIComponent('rtsp://127.0.0.1/live_h264')}&options=${encodeURIComponent('timeout=1')}`;
    const answer = await this.signal(callUrl, 'POST', JSON.stringify(offer));
    await pc.setRemoteDescription(new RTCSessionDescription(answer as RTCSessionDescriptionInit));
    for (const candidate of this.earlyCandidates.splice(0)) await this.pushCandidateRaw(candidate);
  }

  private async pollCandidates(): Promise<void> {
    if (!this.pc) return;
    const list = await this.signal(`/api/getIceCandidate?peerid=${this.peerid}`) as RTCIceCandidateInit[];
    for (const candidate of list ?? []) await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  private async pushCandidate(candidate: RTCIceCandidate): Promise<void> {
    await this.pushCandidateRaw(candidate.toJSON());
  }

  private async pushCandidateRaw(candidate: RTCIceCandidateInit): Promise<void> {
    await this.signal(`/api/addIceCandidate?peerid=${this.peerid}`, 'POST', JSON.stringify(candidate));
  }

  disconnect(): void {
    if (!this.pc) return;
    void this.signal(`/api/hangup?peerid=${this.peerid}`).catch(() => undefined);
    try { this.pc.close(); } catch { /* already closed */ }
    this.pc = null;
    const stream = this.video.srcObject as MediaStream | null;
    stream?.getTracks().forEach((track) => track.stop());
    this.video.srcObject = null;
  }
}

function stopPreview(): void {
  previewGeneration += 1;
  previewConnected = false;
  stopPreviewTimer();
  webrtcPreview?.disconnect();
  webrtcPreview = null;
  mjpegStream?.close();
  mjpegStream = null;
  const img = $('#preview') as HTMLImageElement;
  img.onerror = null;
  img.removeAttribute('src');
}

// MJPEG via the main-process proxy. The camera serves multipart/x-mixed-replace
// but a file://-origin <img> cannot load it (mixed content / credentials).
// Main fetches the stream (session cookies + cert bypass) and forwards raw
// chunks; frames are reassembled here with the JPEG SOI/EOI markers, which is
// immune to every boundary-quoting quirk.
let pendingMjpegPort: MessagePort | null = null;
// preload relays the transferred port via window.postMessage — ports passed
// straight through contextBridge callbacks never deliver messages here.
window.cameraApp.onMjpegPort?.();
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string } | null;
  if (data?.type === 'camera:mjpeg-port' && event.ports[0]) {
    pendingMjpegPort = event.ports[0];
  }
});

class MjpegStream {
  private buffer = new Uint8Array(0);
  private lastUrl: string | null = null;
  closed = false;

  constructor(
    private readonly port: MessagePort,
    private readonly img: HTMLImageElement,
    private readonly onFirstFrame: () => void,
    private readonly onEnd: (why: string) => void
  ) {
    let firstFrame = false;
    port.onmessage = (event: MessageEvent) => {
      const data = event.data as { type: string; chunk?: Uint8Array; status?: number; contentType?: string; message?: string };
      if (data.type === 'chunk' && data.chunk) {
        this.feed(data.chunk);
        if (!firstFrame) { firstFrame = true; this.onFirstFrame(); }
      } else if (data.type === 'error') {
        this.onEnd(data.status ? `HTTP ${data.status}` : data.message ?? 'stream error');
      } else if (data.type === 'end') {
        this.onEnd('stream closed by camera');
      }
    };
    port.onmessageerror = () => this.onEnd('message error');
  }

  private feed(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    for (;;) {
      const start = findSequence(this.buffer, 0, [0xFF, 0xD8]);
      if (start < 0) { if (this.buffer.length > 1) this.buffer = this.buffer.subarray(this.buffer.length - 1); break; }
      const end = findSequence(this.buffer, start + 2, [0xFF, 0xD9]);
      if (end < 0) break; // frame still arriving
      const frame = new Uint8Array(this.buffer.subarray(start, end + 2));
      const url = URL.createObjectURL(new Blob([frame], { type: 'image/jpeg' }));
      if (this.lastUrl) URL.revokeObjectURL(this.lastUrl);
      this.lastUrl = url;
      this.img.src = url;
      this.buffer = new Uint8Array(this.buffer.subarray(end + 2));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.port.close(); } catch { /* already closed */ }
    if (this.lastUrl) URL.revokeObjectURL(this.lastUrl);
  }
}

function findSequence(data: Uint8Array, from: number, seq: number[]): number {
  outer: for (let i = from; i <= data.length - seq.length; i++) {
    for (let j = 0; j < seq.length; j++) if (data[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}

function startPreview(steps: PreviewStep[]): void {
  stopPreview();
  // The probe already proved the camera's own page streams a MJPEG <img>:
  // skip doomed WebRTC steps on every (re)start, not just after a full
  // step-exhaustion pass — otherwise each stream-drop reconnect re-burns
  // ~14s of hopeless WebRTC attempts before MJPEG comes back.
  if (probeSawImgStream && steps.some((s) => s.kind === 'webrtc')) {
    steps = steps.filter((s) => s.kind === 'mjpeg');
  }
  previewSteps = steps;
  previewStepIndex = 0;
  runPreviewStep();
}

function runPreviewStep(): void {
  const step = previewSteps[previewStepIndex];
  const generation = previewGeneration;
  const message = $('#preview-message');
  const img = $('#preview') as HTMLImageElement;
  const video = $('#preview-video') as HTMLVideoElement;
  if (!step) {
    message.textContent = 'Preview stream unavailable — camera may require auth or be busy';
    // Once the camera's own page proved to be a MJPEG <img> (probe), doomed
    // WebRTC steps only burn ~25s per retry loop — drop them for good.
    if (probeSawImgStream && previewSteps.some((s) => s.kind === 'webrtc')) {
      previewSteps = previewSteps.filter((s) => s.kind === 'mjpeg');
      log('Stream probe: camera page streams MJPEG img — dropping WebRTC attempts');
    }
    previewTimer = window.setTimeout(() => { previewStepIndex = 0; runPreviewStep(); }, 5000);
    return;
  }
  message.textContent = step.kind === 'webrtc' ? 'Connecting WebRTC preview...' : 'Loading MJPEG preview...';
  if (step.kind === 'webrtc') {
    img.style.display = 'none';
    video.style.display = '';
    const client = new CameraWebRtc(step.server, video, () => {
      previewConnected = true;
      stopPreviewTimer();
      message.textContent = '';
      log(`WebRTC preview connected: ${step.server}`);
    }, (why) => {
      if (previewConnected) { startPreview(previewSteps); return; } // stream dropped — reconnect from scratch
      log(`WebRTC preview failed (${why}): ${step.server}`);
      advancePreviewStep();
    });
    webrtcPreview = client;
    previewTimer = window.setTimeout(() => {
      if (!previewConnected) { client.disconnect(); advancePreviewStep(); }
    }, 8000);
    client.connect().catch((error) => {
      log(`WebRTC preview failed: ${step.server} — ${String(error)}`);
      if (!previewConnected) { client.disconnect(); advancePreviewStep(); }
    });
  } else {
    video.style.display = 'none';
    img.style.display = '';
    img.onerror = null;
    if (window.cameraApp.startMjpeg && window.cameraApp.onMjpegPort) {
      // Primary path: main-process proxy stream (works for multipart,
      // auth cookies, self-signed TLS — none of which <img> can do here).
      previewTimer = window.setTimeout(() => {
        if (!previewConnected) {
          log(`MJPEG preview timeout (no frames): ${step.url}`);
          mjpegStream?.close(); mjpegStream = null; advancePreviewStep();
        }
      }, 8000);
      void window.cameraApp.startMjpeg(step.url).then((result: { ok: boolean; status: number; contentType: string; error?: string }) => {
        if (generation !== previewGeneration || previewSteps[previewStepIndex] !== step) return;
        if (!result.ok) {
          log(`MJPEG preview failed: ${step.url} — HTTP ${result.status}${result.error ? ` (${result.error})` : ''}`);
          if ((result.status === 401 || result.status === 403) && selected) openConnectDialog(selected, `Authorization required (HTTP ${result.status})`);
          advancePreviewStep();
          return;
        }
        const port = pendingMjpegPort;
        pendingMjpegPort = null;
        if (!port) { log(`MJPEG preview failed: ${step.url} — signaling port missing`); advancePreviewStep(); return; }
        log(`MJPEG stream: HTTP ${result.status} ${result.contentType || 'no content-type'} — port received`);
        mjpegStream = new MjpegStream(port, img, () => {
          previewConnected = true;
          stopPreviewTimer();
          log('MJPEG preview connected (first frame)');
          message.textContent = '';
        }, (why) => {
          mjpegStream?.close();
          mjpegStream = null;
          if (previewConnected) { startPreview(previewSteps); return; } // stream dropped — reconnect
          log(`MJPEG preview failed: ${step.url} — ${why}`);
          advancePreviewStep();
        });
      }).catch((error: unknown) => {
        if (generation !== previewGeneration || previewSteps[previewStepIndex] !== step) return;
        log(`MJPEG preview failed: ${step.url} — ${String(error)}`);
        advancePreviewStep();
      });
    } else {
      img.onerror = () => {
        if (previewConnected) { startPreview(previewSteps); return; }
        log(`MJPEG preview failed: ${step.url}`);
        void window.cameraApp.probeUrl?.(step.url).then((probe: { status: number; contentType: string; error?: string }) => {
          log(`MJPEG probe: HTTP ${probe.status} ${probe.contentType}${probe.error ? ` — ${probe.error}` : ''}`);
        }).catch(() => undefined);
        advancePreviewStep();
      };
      img.onload = () => { previewConnected = true; stopPreviewTimer(); message.textContent = ''; };
      img.src = step.url;
    }
  }
}

function advancePreviewStep(): void {
  stopPreviewTimer();
  previewStepIndex += 1;
  runPreviewStep();
}

function stopPreviewTimer(): void {
  if (previewTimer !== undefined) {
    window.clearTimeout(previewTimer);
    previewTimer = undefined;
  }
}

// Fetches the camera's own web page — the ground truth for which streaming
// mechanism this firmware actually uses — and reports the findings.
async function probeCameraStreamPage(streamUrl: URL): Promise<void> {
  try {
    const probe = await window.cameraApp.probeStream() as { url: string; text: string } | null;
    if (!probe) { log('Stream probe: could not fetch the camera web page'); return; }
    log(`Stream probe: fetched ${probe.url}`);
    const video = /<video[^>]*id=["']?stream/i.test(probe.text);
    const img = /<img[^>]*id=["']?stream/i.test(probe.text);
    log(`Stream probe: stream element = ${video ? 'video (WebRTC)' : img ? 'img (MJPEG)' : 'unknown'}`);
    if (img) probeSawImgStream = true;
    // Raw tags make the real stream element visible in Debug even when the
    // src-extraction regexes below don't match (JS-populated src etc.).
    for (const tag of [...probe.text.matchAll(/<img[^>]*>/gi)].slice(0, 3)) {
      log(`Stream probe img tag: ${tag[0].slice(0, 200)}`);
    }
    const hints = new Set<string>();
    for (const match of probe.text.matchAll(/(?:https?:)?\/\/[^"'\s<>]+/gi)) {
      if (/webrtc|stream|mjpeg|rtsp|:8000|:8443|ws:|wss:/i.test(match[0])) hints.add(match[0]);
    }
    if (hints.size) log(`Stream probe hints: ${[...hints].join(' | ')}`);
    const src = probe.text.match(/<img[^>]*id=["']?stream[^>]*src=["']([^"']+)/i)
      ?? probe.text.match(/<img[^>]*src=["']([^"']*mjpeg[^"']*)["']/i);
    if (src) {
      const target = new URL(src[1], `${streamUrl.protocol}//${streamUrl.host}`).toString();
      log(`Stream probe: detected MJPEG path ${target}`);
      previewSteps.push({ kind: 'mjpeg', url: target });
    }
  } catch (error) {
    log(`Stream probe failed: ${String(error)}`);
  }
}

// Credentials are kept per address (memory only) so camera-rail switching and
// reconnects reuse the Digest login without re-typing the password.
const rememberedCredentials = new Map<string, { username: string; password: string }>();
// Per-address scheme override ('' / 'http' / 'https'). All scheme decisions
// (negotiation order, the https_on switch, 503 hints) live in the main
// process; this only constrains them when the user says so.
const schemeOverrides = new Map<string, '' | 'http' | 'https'>();

// ---------------------------------------------------------------------------
// Connect dialog — a popup (not in-list forms) for authentication and for
// forcing the protocol when auto-negotiation guesses wrong.
// ---------------------------------------------------------------------------

let dialogCamera: Candidate | undefined;

function openConnectDialog(camera: Candidate, error?: string): void {
  dialogCamera = camera;
  $('#connect-title').textContent = `Connect to ${camera.address}`;
  const errorLine = $('#connect-error');
  errorLine.textContent = error ?? '';
  errorLine.classList.toggle('hidden', !error);
  $<HTMLSelectElement>('#connect-scheme').value = schemeOverrides.get(addressKey(camera.address)) ?? '';
  const remembered = rememberedCredentials.get(addressKey(camera.address));
  $<HTMLInputElement>('#connect-user').value = remembered?.username ?? '';
  $<HTMLInputElement>('#connect-pass').value = remembered?.password ?? '';
  $('#connect-dialog').classList.remove('hidden');
  $<HTMLInputElement>('#connect-user').focus();
}

function closeConnectDialog(): void {
  $('#connect-dialog').classList.add('hidden');
  dialogCamera = undefined;
}

// Known credentials → connect straight away; an auth-flagged camera (or the
// first attempt on one) opens the dialog for credentials and scheme choice.
function maybeConnect(camera: Candidate): void {
  if (rememberedCredentials.has(addressKey(camera.address)) || !/auth|\b401\b|\b403\b/i.test(camera.probeError ?? '')) void connect(camera);
  else openConnectDialog(camera);
}

async function connect(camera: Candidate, credentials?: { username: string; password: string }): Promise<void> {
  if (!camera?.address) return;
  const scheme = schemeOverrides.get(addressKey(camera.address)) || undefined;
  if (connecting) {
    // A failed target must never trap the user on its timeout. If the user
    // selects the currently active camera again, promote its preserved main-
    // process session immediately and cancel the queued intent.
    if (selected && addressKey(selected.address) === addressKey(camera.address)) {
      pendingSwitch = undefined;
      void window.cameraApp.activate?.(camera.address);
      $('#scan-status').textContent = `Still connected to ${camera.address}.`;
      $('#preview-message').textContent = '';
      return;
    }
    // Keep only the latest different user intent; the preserved active session
    // remains usable while the new target is being probed.
    pendingSwitch = { camera, credentials };
    const note = `Will switch to ${camera.address} once the current attempt settles...`;
    $('#scan-status').textContent = note;
    $('#preview-message').textContent = note;
    return;
  }
  connecting = true;
  const creds = credentials ?? rememberedCredentials.get(addressKey(camera.address));
  const note = creds ? `Signing in to ${camera.address}...` : `Connecting to ${camera.address}...`;
  $('#scan-status').textContent = note;
  $('#preview-message').textContent = note;
  try {
    const result = await window.cameraApp.connect(camera, creds, scheme);
    if (removedAddresses.has(addressKey(camera.address))) {
      await window.cameraApp.disconnect?.(camera.address);
      throw new Error(`${camera.address} was removed from scan results`);
    }
    if (creds) rememberedCredentials.set(addressKey(camera.address), creds);
    selected = camera;
    displayAddress = camera.address;
    railActiveAddress = camera.address;
    lastStatus = undefined;
    const streamUrl = new URL(result.mjpegUrl);
    const alternate = new URL(streamUrl.toString());
    alternate.protocol = streamUrl.protocol === 'https:' ? 'http:' : 'https:';
    // /info feature flags decide the preview order: firmware without the
    // webrtcStream capability (its own web page streams MJPEG <img>) gets no
    // doomed WebRTC attempts — MJPEG directly. Otherwise mirror the official
    // web UI: same-origin signaling first, opposite origin, legacy ports,
    // then MJPEG on both schemes.
    const info = (result.info ?? {}) as Record<string, unknown>;
    cameraFeatures = (field(info, ['feature']) ?? {}) as Record<string, unknown>;
    const webrtcSupported = cameraFeatures.webrtcStream !== false;
    const webrtcSteps: PreviewStep[] = webrtcSupported ? [
      { kind: 'webrtc', server: streamUrl.origin },
      { kind: 'webrtc', server: alternate.origin },
      { kind: 'webrtc', server: `${streamUrl.protocol}//${streamUrl.hostname}:8000` },
      { kind: 'webrtc', server: `${streamUrl.protocol}//${streamUrl.hostname}:8443` }
    ] : [];
    startPreview([
      ...webrtcSteps,
      { kind: 'mjpeg', url: streamUrl.toString() },
      { kind: 'mjpeg', url: alternate.toString() }
    ]);
    void probeCameraStreamPage(streamUrl);
    // /ctrl/mode responds {code,desc,msg:"rec"} — show msg, never raw JSON.
    $('#hud-mode').textContent = String(field(result.mode, ['msg', 'mode']) ?? camera.name);
    // Feature detection from /info (parsed above for the preview decision):
    // feature.lens_ctrl_ptz (or a "ptz" model name) gates the PTZ settings
    // group; the full feature map is logged once so future UI can key off it.
    cameraSupportsPtz = cameraFeatures.lens_ctrl_ptz === true || /ptz/i.test(String(field(info, ['model']) ?? ''));
    const enabledFeatures = Object.keys(cameraFeatures).filter((key) => cameraFeatures[key] === true);
    log(`Camera features: ${enabledFeatures.join(', ') || 'none flagged true'}${cameraSupportsPtz ? ' (PTZ)' : ' (no PTZ)'}`);
    if (!cameraSupportsPtz && activeGroupId === 'ptz') activeGroupId = SETTINGS_GROUPS[0].id;
    // Restore the settings group this camera was last on before the switch.
    const savedGroup = lastActiveGroupByCamera.get(addressKey(camera.address));
    if (savedGroup && (savedGroup !== 'ptz' || cameraSupportsPtz)) activeGroupId = savedGroup;
    buildSettingsTabs();
    void refreshHud();
    void refreshAfRoi();
    renderCameraRail();
    document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => { tab.disabled = false; });
    resetSettings();
    page('live');
    loadGroup(activeGroupId);
    log(`Connected to ${camera.address} via ${streamUrl.protocol === 'https:' ? 'HTTPS' : 'HTTP'}`);
  } catch (error) {
    // Strip the IPC wrapper ("Error invoking remote method '…': Error: ")
    // so the dialog shows the camera-layer reason only.
    const raw = String(error instanceof Error ? error.message : error);
    const message = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
    if (/\b(?:401|403)\b/.test(message) && camera?.address) {
      // Pop the connect dialog: credentials + protocol switch in one place.
      openConnectDialog(camera, `Authorization failed: ${message}`);
      window.cameraApp.probeLogin(camera.address)
        .then((probe: Record<string, unknown>) => log(`Login probe: ${JSON.stringify(probe)}`))
        .catch((probeError: unknown) => log(`Login probe failed: ${String(probeError)}`));
    }
    // Errors must be visible wherever the user is: the Discover status line
    // AND the preview area (camera switching happens from the Live page).
    const line = `Connection to ${camera?.address ?? 'camera'} failed: ${message}`;
    $('#scan-status').textContent = line;
    $('#preview-message').textContent = line;
    log(`Connection error: ${message}`);
  } finally {
    connecting = false; // Always re-enable switching, even after failures.
    // Run the switch the user requested while this attempt was in flight.
    const pending = pendingSwitch;
    pendingSwitch = undefined;
    if (pending && pending.camera.address !== camera?.address) void connect(pending.camera, pending.credentials);
  }
}

let lastStatus: unknown;
let connecting = false;
// A camera clicked while another connect is still in flight — executed as
// soon as the current attempt settles, so a stuck camera never blocks
// switching.
let pendingSwitch: { camera: Candidate; credentials?: { username: string; password: string } } | undefined;
// Cameras from the last scan, shown in the live-page camera rail.
let discoveredCameras: Candidate[] = [];
// PTZ support comes from /info's feature flags (feature.lens_ctrl_ptz; the
// model name containing "ptz" also implies it). The whole feature object is
// kept for future UI customization (photoSupport, viscaSupport, rtsp, ...).
let cameraSupportsPtz = false;
let cameraFeatures: Record<string, unknown> = {};

// Live HUD mirrors the official web UI (controller.min.js updateLive*):
// shutter depends on sht_operation ("Angle" → live_ae_shutter_angle, else
// live_ae_shutter); ISO ← live_ae_iso; EV ← ev; WB ← mwb (Kelvin); iris ←
// live_ae_fno. Keys the camera does not support show "-" (HUD_KEYS comes
// from the shared schema).

function hudText(response: unknown): string | null {
  if (!response || Number(field(response, ['code']) ?? -1) !== 0) return null;
  const value = field(response, ['value']);
  return value === undefined || value === null ? null : String(value);
}

async function refreshHud(): Promise<void> {
  if (!selected) return;
  try {
    const [shtOp, shtTime, shtAngle, iso, ev, mwb, iris, fps, res] = await Promise.all(
      [...HUD_KEYS].map((key) => window.cameraApp.getSetting(key).catch(() => null))
    );
    let shutter = '-';
    if (shtOp && Number(field(shtOp, ['code']) ?? -1) === 0) {
      const angleMode = field(shtOp, ['type']) === 1 && field(shtOp, ['value']) === 'Angle';
      shutter = hudText(angleMode ? shtAngle : shtTime) ?? '-';
    }
    $('#hud-shutter').textContent = shutter;
    $('#hud-iso').textContent = hudText(iso) ?? '-';
    $('#hud-ev').textContent = hudText(ev) ?? '-';
    $('#hud-wb').textContent = (hudText(mwb) ? `${hudText(mwb)}K` : null) ?? '-';
    $('#hud-iris').textContent = (hudText(iris) ? `F${hudText(iris)}` : null) ?? '-';
    $('#hud-fps').textContent = (hudText(fps) ? `${hudText(fps)}` : null) ?? '-';
    // resolution values can be long ("C4K 2.4:1", "3696x2772 (Low Noise)") —
    // keep the geometry part only so the HUD chip stays compact.
    const resText = hudText(res);
    $('#hud-res').textContent = resText ? (resText.match(/\d{3,5}\s*[x×]\s*\d{3,5}/)?.[0] ?? resText) : '-';
  } catch (error) {
    log(`HUD refresh error: ${String(error)}`);
  }
}

// The rail highlights the camera the user clicked — immediately, success or
// not — falling back to the connected camera on first render.
let railActiveAddress: string | undefined;

function renderCameraRail(): void {
  const rail = $('#live-camera-list');
  const activeAddress = railActiveAddress ?? selected?.address;
  rail.innerHTML = discoveredCameras.length
    ? discoveredCameras.map((camera, index) => `<div class="camera-rail-item${camera.address === activeAddress ? ' active' : ''}" data-index="${index}"><strong>${safe(camera.name)}</strong><span>${safe(camera.address)}</span></div>`).join('')
    : '<p class="muted">Scan on the Discover page to list cameras here.</p>';
  rail.querySelectorAll<HTMLElement>('.camera-rail-item').forEach((item) => {
    item.addEventListener('click', () => {
      rail.querySelectorAll('.camera-rail-item').forEach((el) => el.classList.remove('active'));
      item.classList.add('active');
      const camera = discoveredCameras[Number(item.dataset.index)];
      if (camera) { railActiveAddress = camera.address; maybeConnect(camera); }
    });
  });
}

function formatHms(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function formatRemain(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 60))}h${pad(total % 60)}m`;
}

function updateRecordDuration(seconds: number): void {
  $('#hud-rec-dur').textContent = formatHms(seconds);
  $('#hud-rec-dur').classList.remove('hidden');
}

function updateRecordRemain(seconds: number): void {
  $('#hud-rec-remain').textContent = formatRemain(seconds);
  $('#hud-rec-remain').classList.remove('hidden');
}

function updateRecordFile(name: string): void {
  $('#hud-rec-file').textContent = name;
  $('#hud-rec-file').classList.toggle('hidden', !name);
}

function setRecordingUi(recording: boolean): void {
  const recordButton = $<HTMLButtonElement>('#record');
  recordButton.classList.toggle('recording', recording);
  recordButton.textContent = recording ? '■ STOP' : '● REC';
  $('#hud-rec').classList.toggle('hidden', !recording);
  if (!recording) {
    $('#hud-rec-dur').classList.add('hidden');
    $('#hud-rec-remain').classList.add('hidden');
    $('#hud-rec-file').classList.add('hidden');
    $('#hud-rec-dur').textContent = '';
    $('#hud-rec-remain').textContent = '';
    $('#hud-rec-file').textContent = '';
  } else {
    // A fresh recording restarts the overlay clock and clears any leftover
    // remaining/file labels until RecUpdateRemain / RecordingFile arrive.
    $('#hud-rec-dur').textContent = '00:00:00';
    $('#hud-rec-dur').classList.remove('hidden');
    $('#hud-rec-remain').classList.add('hidden');
    $('#hud-rec-remain').textContent = '';
    $('#hud-rec-file').classList.add('hidden');
    $('#hud-rec-file').textContent = '';
  }
}

async function refreshStatus(): Promise<void> {
  const [status, recording] = await Promise.all([window.cameraApp.status(), window.cameraApp.recordingStatus()]);
  lastStatus = status;
  $('#hud-mode').textContent = String(field(status, ['status', 'msg']) ?? '');
  const isRecording = String(field(recording, ['status']) ?? '').toLowerCase().includes('rec');
  setRecordingUi(isRecording);
  await refreshCardGate(isRecording);
}

// Official record/photo gate (controller.min.js): `/ctrl/card?action=present`
// answers code 0 only when an SD card is in the camera; remaining record time
// comes from `/ctrl/rec?action=remain`. REC is disabled when there is no card
// or the card is full (remaining 0); Photo needs a card and free space too.
// Recording stays stoppable: while REC is active the button is never disabled.
let hasCard = false;
let recordRemainSeconds: number | undefined; // undefined = unknown → don't block
function applyRecordGate(recording: boolean): void {
  const noRemain = recordRemainSeconds !== undefined && recordRemainSeconds <= 0;
  const blockNew = !hasCard || noRemain;
  $<HTMLButtonElement>('#record').disabled = !recording && blockNew;
  $<HTMLButtonElement>('#photo').disabled = blockNew;
}
async function refreshCardGate(recording: boolean): Promise<void> {
  try {
    const response = await window.cameraApp.cardPresent();
    hasCard = !!response && Number(field(response, ['code']) ?? -1) === 0;
  } catch {
    hasCard = false; // camera unreachable — better visibly disabled than silent failure
  }
  try {
    const response = await window.cameraApp.recordingRemain();
    const raw = response ? field(response, ['msg', 'value']) : undefined;
    recordRemainSeconds = raw === undefined || raw === null ? undefined : Number(raw);
  } catch {
    recordRemainSeconds = undefined;
  }
  applyRecordGate(recording);
}
let galleryFolder: string | undefined;
let galleryGeneration = 0;
const galleryObjectUrls = new Set<string>();

function clearGalleryUrls(): void {
  for (const url of galleryObjectUrls) URL.revokeObjectURL(url);
  galleryObjectUrls.clear();
}
function galleryMessage(message: string): void {
  $('#gallery-content').innerHTML = `<p class="muted">${safe(message)}</p>`;
}
function galleryPathLabel(): void {
  $('#gallery-breadcrumb').textContent = galleryFolder ? `DCIM / ${galleryFolder}` : 'DCIM';
  $('#gallery-back').classList.toggle('hidden', !galleryFolder);
}
function formatGallerySize(size?: number): string {
  if (size === undefined) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
function renderGalleryFolders(folders: GalleryFolder[]): void {
  galleryPathLabel();
  if (!folders.length) return galleryMessage('No folders found on the camera.');
  $('#gallery-content').innerHTML = `<div class="gallery-grid">${folders.map((folder) => `<button class="gallery-folder" data-gallery-folder="${safe(folder.name)}"><span class="gallery-folder-icon">▰</span><strong>${safe(folder.name)}</strong><span class="muted">Open folder</span></button>`).join('')}</div>`;
  document.querySelectorAll<HTMLButtonElement>('[data-gallery-folder]').forEach((button) => button.addEventListener('click', () => void openGalleryFolder(button.dataset.galleryFolder!)));
}
function renderGalleryFiles(folder: string, files: GalleryFile[]): void {
  galleryPathLabel();
  if (!files.length) return galleryMessage('No media files found in this folder.');
  $('#gallery-content').innerHTML = `<div class="gallery-grid">${files.map((file) => `<article class="media-tile"><div class="media-preview" data-gallery-media="${safe(file.name)}"><span>${file.kind === 'video' ? '▶' : file.kind === 'image' ? '▧' : '▪'}</span></div><strong title="${safe(file.name)}">${safe(file.name)}</strong><span class="muted">${safe([formatGallerySize(file.size), file.modified].filter(Boolean).join(' · ') || file.kind)}</span></article>`).join('')}</div>`;
  document.querySelectorAll<HTMLElement>('[data-gallery-media]').forEach((tile) => {
    const file = files.find((item) => item.name === tile.dataset.galleryMedia);
    if (!file) return;
    tile.addEventListener('click', () => void openGalleryMedia(folder, file));
    tile.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      void downloadGalleryFile(folder, file);
    });
    const download = document.createElement('button');
    download.className = 'media-download';
    download.type = 'button';
    download.textContent = 'Download';
    download.addEventListener('click', (event) => { event.stopPropagation(); void downloadGalleryFile(folder, file); });
    tile.append(download);
    if (file.kind === 'image') void loadGalleryThumbnail(folder, file, tile);
  });
}
async function loadGalleryThumbnail(folder: string, file: GalleryFile, tile: HTMLElement): Promise<void> {
  try {
    const media = await window.cameraApp.readGalleryMedia(folder, file.name) as { data: Uint8Array; contentType: string };
    const bytes = new Uint8Array(media.data.byteLength); bytes.set(media.data);
    const url = URL.createObjectURL(new Blob([bytes.buffer], { type: media.contentType || 'image/jpeg' }));
    galleryObjectUrls.add(url);
    const preview = tile.querySelector<HTMLElement>('.media-preview');
    if (preview) preview.innerHTML = `<img src="${url}" alt="${safe(file.name)}">`;
  } catch (error) { log(`Gallery thumbnail error: ${String(error)}`); }
}
async function openGalleryFolder(folder: string): Promise<void> {
  const generation = ++galleryGeneration;
  galleryFolder = folder;
  clearGalleryUrls();
  galleryMessage('Loading media…');
  try {
    const files = await window.cameraApp.listGalleryFiles(folder) as GalleryFile[];
    if (generation !== galleryGeneration) return;
    renderGalleryFiles(folder, files);
  } catch (error) {
    if (generation === galleryGeneration) galleryMessage(`Unable to load media: ${String(error)}`);
  }
}
async function openGalleryMedia(folder: string, file: GalleryFile): Promise<void> {
  const generation = galleryGeneration;
  try {
    const media = await window.cameraApp.readGalleryMedia(folder, file.name) as { data: Uint8Array; contentType: string };
    if (generation !== galleryGeneration) return;
    const bytes = new Uint8Array(media.data.byteLength);
    bytes.set(media.data);
    const url = URL.createObjectURL(new Blob([bytes.buffer], { type: media.contentType || 'application/octet-stream' }));
    galleryObjectUrls.add(url);
    const content = $('#media-viewer-content');
    content.innerHTML = file.kind === 'video' ? `<video controls autoplay src="${url}"></video>` : file.kind === 'image' ? `<img src="${url}" alt="${safe(file.name)}">` : `<a class="button" href="${url}" download="${safe(file.name)}">Download ${safe(file.name)}</a>`;
    $('#media-viewer').classList.remove('hidden');
  } catch (error) { log(`Gallery media error: ${String(error)}`); }
}
async function downloadGalleryFile(folder: string, file: GalleryFile): Promise<void> {
  try {
    const result = await window.cameraApp.saveGalleryFile(folder, file.name, file.name) as { canceled: boolean; savedPath?: string };
    if (result.canceled) log('Gallery download canceled');
    else log(`Downloaded ${file.name} → ${result.savedPath ?? 'saved'}`);
  } catch (error) { log(`Gallery download error: ${String(error)}`); }
}
async function refreshLibrary(): Promise<void> {
  const generation = ++galleryGeneration;
  if (!selected) { galleryMessage('Connect a camera to browse media.'); return; }
  galleryFolder = undefined;
  clearGalleryUrls();
  galleryMessage('Loading folders…');
  try {
    const folders = await window.cameraApp.listFolders() as GalleryFolder[];
    if (generation !== galleryGeneration) return;
    renderGalleryFolders(folders);
  } catch (error) {
    if (generation === galleryGeneration) galleryMessage(`Unable to load camera gallery: ${String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// AF focus-area overlay (reference: drawAfRoi / configTouchAf)
// ---------------------------------------------------------------------------

function afOverlay(): HTMLCanvasElement { return $('#af-overlay') as HTMLCanvasElement; }

// The media is letterboxed inside the card via object-fit: contain, so a 0-1
// ROI must map to the actual video pixels, not the whole (possibly wider)
// card. Compute the letterboxed content box in card CSS pixels.
function previewContentBox(): { left: number; top: number; width: number; height: number } {
  const canvas = afOverlay();
  const rect = canvas.getBoundingClientRect();
  return { left: 0, top: 0, width: rect.width, height: rect.height };
}

// Mirror the reference centerElementOnParent: the interactive canvas covers
// the actual contained video frame, not the preview card's letterbox margins.
function sizeAfOverlayToVideo(): void {
  const canvas = afOverlay();
  const card = canvas.parentElement?.getBoundingClientRect();
  if (!card) return;
  const video = $('#preview-video') as HTMLVideoElement;
  const img = $('#preview') as HTMLImageElement;
  const naturalW = video.videoWidth || img.naturalWidth;
  const naturalH = video.videoHeight || img.naturalHeight;
  const hasIntrinsic = naturalW > 0 && naturalH > 0;
  const scale = hasIntrinsic ? Math.min(card.width / naturalW, card.height / naturalH) : 1;
  const width = hasIntrinsic ? naturalW * scale : card.width;
  const height = hasIntrinsic ? naturalH * scale : card.height;
  canvas.style.left = `${(card.width - width) / 2}px`;
  canvas.style.top = `${(card.height - height) / 2}px`;
  canvas.style.right = 'auto';
  canvas.style.bottom = 'auto';
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  if (!hasIntrinsic) log(`AF canvas fallback: video dimensions unavailable; canvas=${Math.round(width)}x${Math.round(height)}`);
}

// Firmware reports the ROI as {code:0, msg:"x:<n>,y:<n>,w:<n>,h:<n>"} with
// 0-1000 values (matching update_roi_center). Accept an object msg as a
// fallback. Values are the top-left corner + size, normalized to 0-1.
function parseRoi(response: unknown): { x: number; y: number; w: number; h: number } | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const record = response as Record<string, unknown>;
  if (Number(record.code ?? -1) !== 0) return undefined;
  const parts: Record<string, number> = {};
  const msg = record.msg;
  if (typeof msg === 'string') {
    for (const chunk of msg.split(',')) {
      const i = chunk.indexOf(':');
      if (i > 0) parts[chunk.slice(0, i).trim()] = Number(chunk.slice(i + 1)) / 1000;
    }
  } else if (msg && typeof msg === 'object') {
    for (const [k, v] of Object.entries(msg as Record<string, unknown>)) {
      if (typeof v === 'number') parts[k] = v / 1000;
    }
  }
  const x = parts.x ?? parts.left ?? parts.cx;
  const y = parts.y ?? parts.top ?? parts.cy;
  const w = parts.w ?? parts.width;
  const h = parts.h ?? parts.height;
  if (x === undefined || y === undefined) return undefined;
  return { x, y, w: w ?? h ?? 0, h: h ?? w ?? 0 };
}

function drawAfRoi(roi: { x: number; y: number; w: number; h: number }): void {
  const canvas = afOverlay();
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(canvas.offsetWidth * dpr) || canvas.height !== Math.round(canvas.offsetHeight * dpr)) {
    canvas.width = Math.round(canvas.offsetWidth * dpr);
    canvas.height = Math.round(canvas.offsetHeight * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.offsetWidth, canvas.offsetHeight);
  if (!roi.w || !roi.h) return;
  const box = previewContentBox();
  const left = box.left + roi.x * box.width;
  const top = box.top + roi.y * box.height;
  const width = roi.w * box.width;
  const height = roi.h * box.height;
  const arm = 18;
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.beginPath();
  ctx.moveTo(left, top + arm); ctx.lineTo(left, top); ctx.lineTo(left + arm, top);
  ctx.moveTo(left + width - arm, top); ctx.lineTo(left + width, top); ctx.lineTo(left + width, top + arm);
  ctx.moveTo(left, top + height - arm); ctx.lineTo(left, top + height); ctx.lineTo(left + arm, top + height);
  ctx.moveTo(left + width - arm, top + height); ctx.lineTo(left + width, top + height); ctx.lineTo(left + width, top + height - arm);
  ctx.stroke();
}

// Socket events (UpdateAfArea / basicInfo.af_roi) report the focus box as
// {roi_x, roi_y, roi_w, roi_h} with the top-left corner + size on a 0-1 scale
// (same geometry the reference draws, just normalized instead of 0-1000).
function showAfRoiFromSocket(x: number, y: number, w: number, h: number): void {
  if (!selected) return;
  afOverlay().style.display = 'block';
  drawAfRoi({ x, y, w, h });
}

// basicInfo entries are either scalars (temp: 43) or {value, ro} pairs
// (live_ae_iso: {value:"400"}); read the displayable value either way.
function basicValue(payload: Record<string, unknown>, key: string): string | undefined {
  const entry = payload[key];
  if (entry && typeof entry === 'object' && 'value' in (entry as Record<string, unknown>)) {
    const v = (entry as Record<string, unknown>).value;
    return v === undefined || v === null ? undefined : String(v);
  }
  return entry === undefined || entry === null ? undefined : String(entry);
}

// A setting row whose snapshot value changed — update its visible value and
// control selection in place, without a network round-trip. The settings
// engine stays authoritative and will rebuild the row on its next snapshot.
function applySnapshotSetting(key: string, entry: unknown): void {
  const row = settingRows.get(key);
  if (!row || row.style.display === 'none') return;
  const raw = entry && typeof entry === 'object' && 'value' in (entry as Record<string, unknown>)
    ? (entry as Record<string, unknown>).value : entry;
  if (raw === undefined || raw === null || raw === '') return;
  const display = String(raw);
  const control = document.getElementById(`control-${cssId(key)}`) as HTMLInputElement | HTMLSelectElement | null;
  const isRange = control instanceof HTMLInputElement && control.type === 'range';
  // Don't fight the user mid-drag on a live-position slider (focus/zoom).
  if (isRange && sliderRecentlyMoved(key)) return;
  const current = findIn<HTMLSpanElement>(row, '.current');
  current.textContent = display;
  current.title = `Current value: ${display}`;
  if (!control) return;
  if (control instanceof HTMLSelectElement) {
    if (Array.from(control.options).some((option) => option.value === display)) control.value = display;
  } else {
    control.value = display;
  }
}

// The camera pushes a full state snapshot as {"what":"basicInfo",...}. Apply
// the live bits straight to the overlay/HUD and gate instead of re-reading.
function applyBasicInfo(payload: Record<string, unknown>): void {
  if (typeof payload.recording === 'boolean') setRecordingUi(payload.recording);
  if (typeof payload.cardPresent === 'boolean') {
    hasCard = payload.cardPresent;
    applyRecordGate($('#record').classList.contains('recording'));
  }
  const roi = payload.af_roi;
  if (roi && typeof roi === 'object') {
    const r = roi as Record<string, unknown>;
    const x = Number(r.x), y = Number(r.y), w = Number(r.w), h = Number(r.h);
    if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) showAfRoiFromSocket(x, y, w, h);
  }
  const get = (key: string) => basicValue(payload, key);
  const angle = get('sht_operation') === 'Angle';
  $('#hud-shutter').textContent = angle ? (get('live_ae_shutter_angle') ?? get('live_ae_shutter') ?? '-') : (get('live_ae_shutter') ?? get('live_ae_shutter_angle') ?? '-');
  $('#hud-iso').textContent = get('live_ae_iso') ?? '-';
  $('#hud-ev').textContent = get('ev_choice') ?? '-';
  const wb = get('mwb');
  $('#hud-wb').textContent = wb ? `${wb}K` : '-';
  const iris = get('live_ae_fno');
  $('#hud-iris').textContent = iris ? `F${iris}` : '-';
  $('#hud-fps').textContent = get('project_fps') ?? '-';
  const res = get('resolution');
  $('#hud-res').textContent = res ? (res.match(/\d{3,5}\s*[x×]\s*\d{3,5}/)?.[0] ?? res) : '-';
  const temp = get('temp');
  if (temp) $('#hud-temp').textContent = `${temp}°C`;
  // Keep any visible settings rows in sync with the snapshot values.
  for (const key of Object.keys(payload)) {
    if (settingRows.has(key) && key !== 'af_roi') applySnapshotSetting(key, payload[key]);
  }
}

async function refreshAfRoi(): Promise<void> {
  const canvas = afOverlay();
  if (!selected) {
    canvas.style.display = 'none';
    const ctx = canvas.getContext('2d');
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  canvas.style.display = 'block';
  sizeAfOverlayToVideo();
  try {
    // Best-effort from /ctrl/af?action=query; the socket (UpdateAfArea /
    // basicInfo.af_roi) is authoritative, so a failed/empty query leaves the
    // current box in place instead of erasing it.
    const roi = parseRoi(await window.cameraApp.lensRoi('query'));
    if (roi) drawAfRoi(roi);
  } catch (error) {
    log(`AF ROI query error: ${String(error)}`);
  }
}

// Clicking the preview focuses there. In "Flexible Zone" AF the click moves
// the ROI frame (update_roi_center, 0-1000); otherwise it triggers one-push
// AF, matching the reference focus_area gating.
function wireAfOverlay(): void {
  afOverlay().addEventListener('click', (event: MouseEvent) => {
    if (!selected) return;
    sizeAfOverlayToVideo();
    const canvas = afOverlay();
    const x = Math.max(0, Math.min(1, event.offsetX / Math.max(1, canvas.clientWidth))) * 1000;
    const y = Math.max(0, Math.min(1, event.offsetY / Math.max(1, canvas.clientHeight))) * 1000;
    const video = $('#preview-video') as HTMLVideoElement;
    const img = $('#preview') as HTMLImageElement;
    const url = `/ctrl/af?action=update_roi_center&x=${encodeURIComponent(String(x))}&y=${encodeURIComponent(String(y))}`;
    log(`AF click: canvas=${canvas.clientWidth}x${canvas.clientHeight}, video=${video.videoWidth || img.naturalWidth}x${video.videoHeight || img.naturalHeight}, offset=${event.offsetX},${event.offsetY} -> send x=${x.toFixed(6)} y=${y.toFixed(6)} ${url}`);
    void Promise.all([
      window.cameraApp.getSetting('af_mode').catch(() => undefined),
      window.cameraApp.getSetting('focus_area').catch(() => undefined)
    ]).then(([afModeResponse, focusAreaResponse]: [unknown, unknown]) => {
      // Current firmware reports the selectable ROI mode as af_mode. Older
      // firmware used focus_area, so retain that as a compatibility fallback.
      const afMode = String(field(afModeResponse, ['value']) ?? '');
      const focusArea = String(field(focusAreaResponse, ['value']) ?? '');
      const flexible = afMode === 'Flexible Zone' || (!afMode && focusArea === 'Flexible Zone');
      log(`AF click mode: af_mode=${afMode || '-'}, focus_area=${focusArea || '-'} -> ${flexible ? 'update_roi_center' : 'one-push AF'}`);
      if (flexible) {
        void window.cameraApp.lensRoi('update', x, y)
          .then((response: unknown) => { log(`AF ROI response: ${JSON.stringify(response)}`); return response; })
          .catch((error: unknown) => log(`AF ROI update error: ${String(error)}`))
          .then(() => refreshAfRoi());
      } else {
        void window.cameraApp.lensAction('af')
          .then((response: unknown) => log(`AF one-push response: ${JSON.stringify(response)}`))
          .catch((error: unknown) => log(`AF error: ${String(error)}`));
      }
    }).catch((error: unknown) => log(`AF mode read error: ${String(error)}`));
  });
  const video = $('#preview-video') as HTMLVideoElement;
  const img = $('#preview') as HTMLImageElement;
  video.addEventListener('loadedmetadata', () => { sizeAfOverlayToVideo(); void refreshAfRoi(); });
  img.addEventListener('load', () => { sizeAfOverlayToVideo(); void refreshAfRoi(); });
  window.addEventListener('resize', () => { sizeAfOverlayToVideo(); });
}

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

// Groups load through `/ctrl/getbatch?catalog=<name>` (official web UI
// pattern); `perKey` settings (sliders/ranges) are read individually.
// Group keys, catalogs and types live in the shared schema module.

/**
 * Official postSetConfig dependency map comes from the shared schema
 * (DEPENDENT_GROUPS), as do the boolean option pairs.
 */

let activeGroupId = SETTINGS_GROUPS[0].id;
// The last settings group each camera was on — switching away and back
// restores that camera's own tab instead of the global last one.
const lastActiveGroupByCamera = new Map<string, string>();
// Timestamp of the user's last drag on a slider row. Live position updates
// (socket / re-reads) are skipped for a short window so the thumb that the
// user just moved is not yanked back to a camera-reported value mid-drag —
// mirroring the reference FZCtrl delayUpdate behavior.
const sliderUserMoveAt = new Map<string, number>();
function sliderRecentlyMoved(key: string): boolean {
  const at = sliderUserMoveAt.get(key);
  return at !== undefined && Date.now() - at < 1200;
}
const loadedGroups = new Set<string>();
const loadingGroups = new Set<string>();
const settingRows = new Map<string, HTMLElement>();
const definitionByKey = new Map<string, SettingDef>();
// Keys the background engine marks editable (mode-dependent overrides). The
// value's raw `ro` is only a fallback when a key is absent here.
const forceEditableKeys = new Set<string>();

/** Firmware option/value strings contain stray backslash escapes (e.g. "C4K\ 2.4:1"). */
function clean(s: string): string { return s.replace(/\\/g, ''); }

/**
 * Parse one `/ctrl/get?k=...` response into display value + choice list.
 * Firmware shape is flat: { code, desc, key, type, ro, value, opts[] }.
 * Dispatch follows the official web UI: type 1 = choices in `opts`,
 * type 2 = numeric min/max/step, type 3 = free text. Nested container
 * shapes are still accepted defensively.
 */
function parseSetting(key: string, response: unknown): { current: string; options?: string[]; range?: { min: number; max: number; step: number }; readOnly?: boolean; error?: string } {
  if (!response || typeof response !== 'object') return { current: '-', error: 'No data' };
  const record = response as Record<string, unknown>;
  if ('__error' in record) return { current: '-', error: String(record.__error) };
  if (typeof record.code === 'number' && record.code !== 0) {
    return { current: '-', error: record.code === -1 ? 'Not supported by this camera' : String(record.desc ?? `Code ${record.code}`) };
  }

  const readOnly = record.ro === 1 || record.ro === true || record.ro === '1';
  let data = record.value;
  const type = Number(record.type ?? 0);

  // Choices: array form or object map ({ "0": "Low", "1": "Middle", ... }).
  const rawOptions: unknown[] | undefined = Array.isArray(record.opts) ? record.opts
    : Array.isArray(record.options) ? record.options
    : Array.isArray(record.values) ? record.values
    : record.opts && typeof record.opts === 'object' ? Object.values(record.opts as Record<string, unknown>)
    : undefined;
  let options = rawOptions?.map((entry) => typeof entry === 'string' || typeof entry === 'number' ? clean(String(entry)) : String((entry as Record<string, unknown>).value ?? (entry as Record<string, unknown>).name ?? JSON.stringify(entry)));

  if (!options && !Array.isArray(data) && typeof data !== 'boolean') {
    // Legacy/nested shapes: { <key>: "x" } or { <key>: { value, options } }
    const metaKeys = new Set(['code', 'desc', 'k', 'msg', 'key', 'type', 'ro', 'min', 'max', 'step', 'all']);
    if (data === undefined && key in record) data = record[key];
    if (data === undefined) {
      const fallbackKey = Object.keys(record).find((name) => !metaKeys.has(name));
      if (fallbackKey !== undefined) data = record[fallbackKey];
    }
  }

  // Numeric range (type 2, min/max/step without opts) renders as a slider.
  let range: { min: number; max: number; step: number } | undefined;
  if (!options && typeof record.min === 'number' && typeof record.max === 'number') {
    const step = typeof record.step === 'number' && record.step > 0 ? record.step : 1;
    range = { min: Number(record.min), max: Number(record.max), step };
  }

  if (data === null || data === undefined || data === '') return { current: '-', error: 'Value missing', readOnly };

  let value: string;
  if (typeof data === 'object' && !Array.isArray(data)) {
    const container = data as Record<string, unknown>;
    const nestedOptions = Array.isArray(container.opts) ? container.opts : Array.isArray(container.options) ? container.options : undefined;
    if (nestedOptions && !options) {
      options = nestedOptions.map((entry) => typeof entry === 'string' || typeof entry === 'number' ? clean(String(entry)) : String((entry as Record<string, unknown>).value ?? JSON.stringify(entry)));
    }
    data = container.value ?? container.current ?? container.val ?? data;
  }
  value = clean(typeof data === 'object' ? JSON.stringify(data) : String(data));

  // Boolean-like values without choices become an on/off style select,
  // matching whatever vocabulary the firmware already uses.
  if (!options) {
    const lower = value.toLowerCase();
    for (const [, pair] of Object.entries(BOOLEAN_PAIRS)) {
      if (pair.includes(lower)) { options = [...pair]; break; }
    }
  }
  return { current: value, options, range, readOnly };
}

function findIn<T extends HTMLElement>(root: Element, selector: string): T { return root.querySelector<T>(selector)!; }
function cssId(key: string): string { return key.replace(/[^a-z0-9_-]/gi, '_'); }

function buildSettingsTabs(): void {
  const tabs = $('#settings-tabs');
  const pages = $('#settings-pages');
  tabs.innerHTML = '';
  pages.innerHTML = '';
  settingRows.clear();
  definitionByKey.clear();
  const subgroupContainers = new Map<string, HTMLDivElement>();
  // Render System (and its subgroups) last so the low-frequency sections sit at
  // the bottom of the sidebar. Relative order elsewhere is preserved.
  const isSystemGroup = (group: typeof SETTINGS_GROUPS[number]) => group.id === 'system' || group.parent === 'system';
  const orderedGroups = [...SETTINGS_GROUPS].sort((a, b) => Number(isSystemGroup(a)) - Number(isSystemGroup(b)));

  for (const group of orderedGroups) {
    // PTZ is model-dependent (detected from /info at connect) — non-PTZ
    // cameras get neither the tab nor the page.
    if (group.id === 'ptz' && !cameraSupportsPtz) continue;
    const tabButton = document.createElement('button');
    tabButton.className = 'subtab';
    tabButton.dataset.settings = group.id;
    tabButton.textContent = group.label;
    tabButton.addEventListener('click', () => showGroup(group.id));
    if (group.parent) {
      let container = subgroupContainers.get(group.parent);
      if (!container) {
        container = document.createElement('div');
        container.className = 'settings-subgroup';
        container.dataset.parent = group.parent;
        subgroupContainers.set(group.parent, container);
        const parentButton = tabs.querySelector<HTMLButtonElement>(`.subtab[data-settings="${group.parent}"]`);
        if (parentButton) parentButton.insertAdjacentElement('afterend', container);
        else tabs.append(container);
      }
      tabButton.classList.add('subgroup-tab');
      container.append(tabButton);
    } else {
      tabs.append(tabButton);
    }

    const panel = document.createElement('div');
    panel.className = 'settings-page';
    panel.setAttribute('data-settings-page', group.id);

    const heading = document.createElement('h3');
    heading.textContent = group.label;
    panel.append(heading);

    // No manual refresh button: WS config-change events already keep every
    // row in sync (values, choices, and dependent groups).

    for (const def of group.settings) panel.append(buildSettingRow(def));

    pages.append(panel);
  }
}

function buildSettingRow(def: SettingDef): HTMLElement {
  const row = document.createElement('div');
  row.className = 'setting-row';

  const name = document.createElement('strong');
  name.textContent = def.label;
  row.append(name);

  const current = document.createElement('span');
  current.className = 'current';
  current.textContent = '-';
  row.append(current);

  // Value reads happen automatically on connect/group-open; writes fire
  // automatically from control change events. Unsupported rows are hidden.
  const controls = document.createElement('div');
  controls.className = 'setting-controls';
  controls.id = `controls-${cssId(def.key)}`;
  row.append(controls);

  if (def.custom === 'stream-bitrate') {
    // Mbps with 0.1 steps like the official spinner; the camera layer
    // converts to bps and returns a fresh snapshot.
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.id = `control-${cssId(def.key)}`;
    input.onchange = () => void setStreamBitrate(input.value);
    controls.append(input);
  } else if (def.custom === 'rtmp-push') {
    // Full-width row so the URL, key and Start/Stop button sit comfortably.
    row.classList.add('rtmp-row');
    row.style.display = 'none'; // shown by applyStreamSnapshot when supported
    const url = document.createElement('input');
    url.type = 'text';
    url.className = 'stream-url';
    url.placeholder = 'rtmp://server/live';
    url.id = `rtmp-url-input`;
    url.onchange = () => void startRtmpPush('start');
    const key = document.createElement('input');
    key.type = 'text';
    key.className = 'stream-key';
    key.placeholder = 'Stream key';
    key.id = `rtmp-key-input`;
    key.onchange = () => void startRtmpPush('start');
    const toggle = document.createElement('button');
    toggle.className = 'secondary rtmp-toggle';
    toggle.textContent = 'Start';
    toggle.onclick = () => void startRtmpPush(toggle.textContent === 'Start' ? 'start' : 'stop');
    controls.append(url, key, toggle);
  }

  settingRows.set(def.key, row);
  definitionByKey.set(def.key, def);
  return row;
}

// --- Custom streaming rows (camera layer snapshots) ------------------------

type StreamSnapshot = {
  index: string;
  bitrateMbps?: number;
  bitrateRaw?: number;
  encoderType?: string;
  streamStatus?: string;
  rtmp?: { url: string; key: string; busy: boolean };
  supported: { bitrate: boolean; rtmp: boolean };
  bitrateRo?: boolean;
  /** Full /ctrl/stream_setting query (resolutionList, fpsList, Ro flags...). */
  detail?: Record<string, unknown>;
};

/** Renders a camera-layer snapshot; unsupported rows stay hidden. */
function applyStreamSnapshot(snapshot: StreamSnapshot): void {
  const bitrate = document.getElementById('control-stream_bitrate') as HTMLInputElement | null;
  const bitrateRow = settingRows.get('stream_bitrate');
  if (snapshot.supported.bitrate) {
    if (bitrateRow) bitrateRow.style.display = '';
    if (bitrate && document.activeElement !== bitrate) bitrate.value = snapshot.bitrateMbps !== undefined ? String(snapshot.bitrateMbps) : '';
    if (bitrate) bitrate.disabled = snapshot.bitrateRo === true;
    log(`Stream bitrate: raw=${snapshot.bitrateRaw ?? '-'} kbps, display=${snapshot.bitrateMbps ?? '-'} Mbps, ro=${snapshot.bitrateRo ? 'true' : 'false'}`);
  } else {
    hideSettingRow('stream_bitrate');
    log('Stream bitrate unavailable');
  }

  const url = document.getElementById('rtmp-url-input') as HTMLInputElement | null;
  const key = document.getElementById('rtmp-key-input') as HTMLInputElement | null;
  if (url && document.activeElement !== url) url.value = snapshot.rtmp?.url ?? '';
  if (key && document.activeElement !== key) key.value = snapshot.rtmp?.key ?? '';
  const rtmpToggle = document.querySelector<HTMLButtonElement>('#controls-rtmp_push .rtmp-toggle');
  if (rtmpToggle) rtmpToggle.textContent = snapshot.rtmp?.busy ? 'Stop' : 'Start';
  const rtmpRow = settingRows.get('rtmp_push');
  if (!snapshot.supported.rtmp) { hideSettingRow('rtmp_push'); log('RTMP unavailable'); }
  else if (rtmpRow) rtmpRow.style.display = '';

  if (snapshot.encoderType) log(`Stream: ${snapshot.encoderType}, bitrate ${snapshot.bitrateMbps} Mbps, status ${snapshot.streamStatus ?? '?'}`);
}

async function loadStreamingCustomRows(): Promise<void> {
  try {
    applyStreamSnapshot(await window.cameraApp.streamState() as StreamSnapshot);
  } catch (error) {
    log(`Stream state unavailable: ${String(error)}`);
  }
}

async function setStreamBitrate(rawMbps: string): Promise<void> {
  const mbps = Number(rawMbps);
  if (!Number.isFinite(mbps) || mbps <= 0) { log(`Invalid bitrate: ${rawMbps}`); return void loadStreamingCustomRows(); }
  try {
    applyStreamSnapshot(await window.cameraApp.streamSetBitrate(mbps) as StreamSnapshot);
    log('Set stream bitrate ok');
  } catch (error) {
    log(`Set stream bitrate failed: ${String(error)}`);
    await loadStreamingCustomRows();
  }
}

async function startRtmpPush(action: 'start' | 'stop'): Promise<void> {
  try {
    if (action === 'start') {
      const url = (document.getElementById('rtmp-url-input') as HTMLInputElement | null)?.value.trim() ?? '';
      const key = (document.getElementById('rtmp-key-input') as HTMLInputElement | null)?.value.trim() ?? '';
      applyStreamSnapshot(await window.cameraApp.streamRtmp('start', url || undefined, key || undefined) as StreamSnapshot);
    } else {
      applyStreamSnapshot(await window.cameraApp.streamRtmp('stop') as StreamSnapshot);
    }
    log(`RTMP ${action} ok`);
  } catch (error) {
    log(`RTMP ${action} failed: ${String(error)}`);
  }
  await loadStreamingCustomRows();
}

function removeControl(key: string): void {
  document.getElementById(`control-${cssId(key)}`)?.remove();
}

function ensureControl(key: string, kind: 'select' | 'input' | 'range'): HTMLInputElement | HTMLSelectElement | null {
  const holder = document.getElementById(`controls-${cssId(key)}`);
  if (!holder) return null;

  let element = document.getElementById(`control-${cssId(key)}`);
  const matches = element && (kind === 'select'
    ? element instanceof HTMLSelectElement
    : element instanceof HTMLInputElement && element.type === (kind === 'range' ? 'range' : 'text'));
  if (element && !matches) { element.remove(); element = null; }

  if (!element) {
    element = document.createElement(kind === 'select' ? 'select' : 'input');
    if (element instanceof HTMLInputElement) element.type = kind === 'range' ? 'range' : 'text';
    element.id = `control-${cssId(key)}`;
    holder.insertBefore(element, holder.firstChild);
  }
  return element as HTMLInputElement | HTMLSelectElement;
}

function showGroup(groupId: string): void {
  activeGroupId = groupId;
  if (selected) lastActiveGroupByCamera.set(addressKey(selected.address), groupId);
  document.querySelectorAll('#settings-tabs .subtab').forEach((item) => item.classList.toggle('active', (item as HTMLElement).dataset.settings === groupId));
  document.querySelectorAll('#settings-pages .settings-page').forEach((item) => item.classList.toggle('active', item.getAttribute('data-settings-page') === groupId));
  loadGroup(groupId);
}

function loadGroup(groupId: string, force = false): void {
  if (!selected || (!force && (loadedGroups.has(groupId) || loadingGroups.has(groupId)))) return;
  loadingGroups.add(groupId);
  loadedGroups.delete(groupId);
  void window.cameraApp.loadSettingsGroup(groupId, force).then((snapshot: any) => {
    if (!selected || snapshot?.groupId !== groupId) return;
    const group = SETTINGS_GROUPS.find((item) => item.id === groupId);
    const visible = new Set<string>(snapshot.visibleKeys ?? []);
    // The engine is the authority on read-only state (mode-dependent, e.g. WB
    // Manual forces CCT editable). Everything visible-but-not-disabled is editable.
    const disabled = new Set<string>(snapshot.disabledKeys ?? []);
    forceEditableKeys.clear();
    for (const key of snapshot.visibleKeys ?? []) if (!disabled.has(key)) forceEditableKeys.add(key);
    for (const [key, value] of Object.entries(snapshot.values ?? {})) applySettingResponse(key, value);
    // Values are applied first (which may reveal rows), then hide the rows the
    // engine says the camera does not support / is in an incompatible mode.
    for (const def of group?.settings ?? []) {
      if (!def.custom && !visible.has(def.key)) hideSettingRow(def.key);
    }
    loadedGroups.add(groupId);
    if (group?.settings.some((item) => item.custom)) void loadStreamingCustomRows();
  }).catch((error: unknown) => log(`Load ${groupId} settings failed: ${String(error)}`))
    .finally(() => loadingGroups.delete(groupId));
}

function hideSettingRow(key: string): void {
  const row = settingRows.get(key);
  if (!row) return;
  row.style.display = 'none';
  removeControl(key);
}

function applySettingResponse(key: string, response: unknown): void {
  const row = settingRows.get(key);
  const def = definitionByKey.get(key);
  if (!row || !def) return;

  const parsed = parseSetting(key, response);

  // Unsupported / errored settings are hidden entirely; details stay in the
  // debug panel via the load/write log lines.
  if (parsed.error) {
    row.style.display = 'none';
    removeControl(key);
    return;
  }
  row.style.display = '';
  if (HUD_KEYS.has(key)) void refreshHud();

  const current = findIn<HTMLSpanElement>(row, '.current');
  current.title = `Current value: ${parsed.current}`;

  // The background engine is the authority on read-only state (it captures
  // mode-dependent semantics, e.g. WB Manual forcing CCT editable). The value's
  // raw `ro` is a fallback only.
  const editable = forceEditableKeys.has(key) ? true : !(parsed.readOnly || def.readOnly);

  // The reference hides focus/zoom position controls when the camera reports
  // them read-only; do not leave a disabled slider occupying the row.
  if ((key === 'lens_focus_pos' || key === 'lens_zoom_pos') && (parsed.readOnly || def.readOnly)) {
    row.style.display = 'none';
    removeControl(key);
    return;
  }

  const kind = parsed.range ? 'range' : parsed.options?.length ? 'select' : 'input';
  const control = ensureControl(key, kind);
  if (!control) { current.hidden = false; current.textContent = parsed.current; return; }

  if (control instanceof HTMLInputElement && control.type === 'range' && parsed.range) {
    // Keep the camera-reported range anchored, but do not overwrite the
    // user's just-moved thumb until the short FZCtrl-style settling window.
    control.min = String(parsed.range.min);
    control.max = String(parsed.range.max);
    control.step = String(parsed.range.step);
    if (!sliderRecentlyMoved(key)) {
      control.value = parsed.current;
      current.textContent = parsed.current;
    }
    current.hidden = false;
    control.oninput = () => {
      sliderUserMoveAt.set(key, Date.now());
      current.textContent = control.value;
    };
    control.onchange = () => {
      sliderUserMoveAt.set(key, Date.now());
      if (editable) void writeSetting(key, control.value);
    };
  } else if (control instanceof HTMLSelectElement) {
    current.hidden = true;
    const options = [...parsed.options!];
    // Option lists may differ in case from the current value ("Off" vs "off").
    let matched = matchOption(options, parsed.current);
    if (matched === undefined) {
      options.unshift(parsed.current); // Official web UI pushes the live value into the list.
      matched = parsed.current;
    }
    control.innerHTML = options.map((option) => `<option value="${safe(option)}">${safe(option)}</option>`).join('');
    control.value = matched;
    control.onchange = () => void writeSetting(key, control.value);
  } else {
    current.hidden = true;
    control.value = parsed.current;
    control.onchange = () => void writeSetting(key, (control as HTMLInputElement).value);
  }
  control.disabled = !editable;
}

function matchOption(options: string[], value: string): string | undefined {
  const target = value.toLowerCase();
  const numericValue = value.trim() !== '' ? Number(value) : NaN;
  return options.find((option) => {
    if (option.toLowerCase() === target) return true;
    // Numeric selections must not fail on formatting differences.
    if (!Number.isNaN(numericValue)) {
      const candidate = Number(option);
      return !Number.isNaN(candidate) && Math.abs(candidate - numericValue) <= 1e-9 * Math.max(1, Math.abs(numericValue));
    }
    return false;
  });
}

async function refreshSetting(key: string): Promise<void> {
  const row = settingRows.get(key);
  if (!row) return;
  try {
    applySettingResponse(key, await window.cameraApp.getSetting(key));
  } catch (error) {
    log(`Read ${key} error: ${String(error)}`);
  }
}

async function writeSetting(key: string, value: string): Promise<void> {
  try {
    const snapshots = await window.cameraApp.setSetting(key, value) as any[];
    log(`Set ${key}=${value}`);
    for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
      const group = SETTINGS_GROUPS.find((item) => item.id === snapshot?.groupId);
      const visible = new Set<string>(snapshot?.visibleKeys ?? []);
      const disabled = new Set<string>(snapshot?.disabledKeys ?? []);
      forceEditableKeys.clear();
      for (const visibleKey of snapshot?.visibleKeys ?? []) if (!disabled.has(visibleKey)) forceEditableKeys.add(visibleKey);
      for (const [snapshotKey, response] of Object.entries(snapshot?.values ?? {})) applySettingResponse(snapshotKey, response);
      for (const def of group?.settings ?? []) if (!def.custom && !visible.has(def.key)) hideSettingRow(def.key);
      loadedGroups.add(snapshot.groupId);
    }
  } catch (error) {
    log(`Set ${key} error: ${String(error)}`);
    await refreshSetting(key);
  }
}

function resetSettings(): void {
  loadedGroups.clear();
  loadingGroups.clear();
  // Preserve custom controls (stream bitrate); only generic schema controls
  // are rebuilt from the next settings snapshot.
  document.querySelectorAll('#settings-pages select[id^="control-"], #settings-pages input[id^="control-"]:not(#control-stream_bitrate)').forEach((element) => element.remove());
  for (const [, row] of settingRows) { row.style.display = ''; findIn<HTMLSpanElement>(row, '.current').textContent = '-'; }
}

// ---------------------------------------------------------------------------
// Global wiring
// ---------------------------------------------------------------------------

function initWiring(): void {

wireAfOverlay();
$('#scan').addEventListener('click', () => void scan());
// Connect dialog wiring: Cancel / backdrop close it; Connect applies the
// chosen protocol and credentials (if any) then connects.
$('#connect-cancel').addEventListener('click', closeConnectDialog);
$('#connect-dialog').addEventListener('click', (event) => { if (event.target === $('#connect-dialog')) closeConnectDialog(); });
$('#connect-go').addEventListener('click', () => {
  const camera = dialogCamera;
  if (!camera) return;
  const scheme = $<HTMLSelectElement>('#connect-scheme').value;
  const key = addressKey(camera.address);
  if (scheme) schemeOverrides.set(key, scheme as 'http' | 'https'); else schemeOverrides.delete(key);
  const username = $<HTMLInputElement>('#connect-user').value.trim();
  const password = $<HTMLInputElement>('#connect-pass').value;
  closeConnectDialog();
  void connect(camera, username ? { username, password } : undefined);
});
$('#connect-pass').addEventListener('keydown', (event) => { if ((event as KeyboardEvent).key === 'Enter') $('#connect-go').click(); });
renderCameraList(); // Empty list with the "+ Add camera manually" box.
void window.cameraApp.interfaces().then((items: Array<{ name: string; address: string; family: string }>) => { const select = $<HTMLSelectElement>('#interface'); items.forEach((item) => { const option = document.createElement('option'); option.value = item.address; option.textContent = `${item.name} - ${item.address} (${item.family})`; select.append(option); }); }).then(() => void scan()).catch((error: unknown) => { $('#scan-status').textContent = `Interface enumeration failed: ${String(error)}`; });

document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => tab.addEventListener('click', () => page(tab.dataset.page!)));
buildSettingsTabs();
showGroup(activeGroupId);

$('#debug-toggle').addEventListener('click', () => { $('#debug-panel').hidden = false; }); $('#debug-close').addEventListener('click', () => { $('#debug-panel').hidden = true; }); $('#debug-clear').addEventListener('click', () => { $('#debug-log').textContent = ''; }); $('#debug-copy').addEventListener('click', () => { void navigator.clipboard.writeText($('#debug-log').textContent ?? '').then(() => { const button = $<HTMLButtonElement>('#debug-copy'); button.textContent = 'Copied'; window.setTimeout(() => { button.textContent = 'Copy'; }, 1500); }); });

// ---------------------------------------------------------------------------
// Panel visibility (Live page) — three icon buttons left of Debug, one per
// panel. Click toggles directly; dimmed icon = panel closed. State persists.
// ---------------------------------------------------------------------------

const PANEL_ICONS: Array<{ button: string; className: string; storage: string }> = [
  { button: '#panel-camera-toggle', className: 'rail-hidden', storage: 'panel.camera' },
  { button: '#panel-preview-toggle', className: 'preview-hidden', storage: 'panel.preview' },
  { button: '#panel-settings-toggle', className: 'settings-hidden', storage: 'panel.settings' }
];
function applyPanels(): void {
  for (const toggle of PANEL_ICONS) {
    const hidden = document.body.classList.contains(toggle.className);
    $<HTMLButtonElement>(toggle.button).classList.toggle('off', hidden);
    try { localStorage.setItem(toggle.storage, hidden ? '0' : '1'); } catch { /* storage unavailable — session-only */ }
  }
}
for (const toggle of PANEL_ICONS) {
  try { if (localStorage.getItem(toggle.storage) === '0') document.body.classList.add(toggle.className); } catch { /* default shown */ }
  $<HTMLButtonElement>(toggle.button).addEventListener('click', () => { document.body.classList.toggle(toggle.className); applyPanels(); });
}
applyPanels();
// Per-panel × buttons close the panel itself; applyPanels keeps the
// ▤/▶/⚙ tool icons in sync with the closed state.
$('#rail-close').addEventListener('click', () => { document.body.classList.add('rail-hidden'); applyPanels(); });
$('#preview-close').addEventListener('click', () => { document.body.classList.add('preview-hidden'); applyPanels(); });
$('#settings-close').addEventListener('click', () => { document.body.classList.add('settings-hidden'); applyPanels(); });
$('#record').addEventListener('click', async () => { const recordButton = $<HTMLButtonElement>('#record'); const start = !recordButton.classList.contains('recording'); recordButton.disabled = true; try { await (start ? window.cameraApp.startRecording() : window.cameraApp.stopRecording()); } finally { recordButton.disabled = false; void refreshStatus(); } }); $('#photo').addEventListener('click', async () => { try { await window.cameraApp.capturePhoto(); log('Photo captured'); } catch (error) { log(`Photo error: ${String(error)}`); } }); $('#gallery-refresh').addEventListener('click', () => void (galleryFolder ? openGalleryFolder(galleryFolder) : refreshLibrary())); $('#gallery-back').addEventListener('click', () => void refreshLibrary()); $('#media-viewer-close').addEventListener('click', () => { $('#media-viewer').classList.add('hidden'); }); $('#media-viewer').addEventListener('click', (event) => { if (event.target === $('#media-viewer')) $('#media-viewer').classList.add('hidden'); });

// ---------------------------------------------------------------------------
// Notifications — debug panel shows only values that actually changed.
// ---------------------------------------------------------------------------

window.cameraApp.onActiveChanged?.((update: { address?: string; ok: boolean }) => {
  if (!update.ok || !update.address) return;
  const camera = discoveredCameras.find((item) => addressKey(item.address) === addressKey(update.address!));
  if (!camera) return;
  selected = camera;
  displayAddress = camera.address;
  railActiveAddress = camera.address;
  renderCameraRail();
});

const lastPayloads = new Map<string, string>();
// Periodic events change every tick; logging them is pure noise.
const SUPPRESSED_EVENTS = new Set(['heartbeat', 'recording-duration', 'recording-remaining', 'temperature', 'ai-detection', 'audio-volume', 'battery_voltage', 'basic-info']);
// High-frequency telemetry keys (volume metering, battery) — skip entirely.
// Some firmware sends these as {"what":"audioVolume","audio_lvl":[...]},
// others as key/value pairs — cover both shapes.
const NOISY_SETTING_KEYS = /audiov?olume|audio_lvl|audiolevel|battery_voltage|^tint$/i;
// AF settings that move or reshape the on-preview focus frame — changing them
// re-queries the ROI so the drawn box tracks the current area.
const AF_ROI_KEYS = new Set(['af_area', 'af_mode', 'focus_area']);

window.cameraApp.onEvent((update: any) => {
  const address = String(update?.address ?? '');
  if (displayAddress && address && addressKey(address) !== addressKey(displayAddress)) return;
  const event = update?.event ?? update;
  const signature = JSON.stringify(event.payload ?? {});
  // af-area-changed always redraws (the box may have been cleared by a switch);
  // all other events skip when their payload is unchanged.
  if (event.type !== 'af-area-changed' && lastPayloads.get(event.type) === signature) return;
  lastPayloads.set(event.type, signature);

  const summaryKey = event.payload?.key ?? event.payload?.config_key ?? event.payload?.k ?? event.payload?.what;
  const summaryValue = event.payload?.value ?? event.payload?.v;
  // Volume, AI detection, and temperature are useful overlay telemetry but
  // are intentionally omitted from the debug panel even when their values
  // change on every notification.
  const what = String(event.payload?.what ?? '').toLowerCase();
  const telemetryOnly = SUPPRESSED_EVENTS.has(event.type)
    || what === 'aidetection'
    || what === 'audiovolume' || (summaryKey !== undefined && NOISY_SETTING_KEYS.test(String(summaryKey)));
  if (summaryKey !== undefined && HUD_KEYS.has(String(summaryKey))) {
    // AE-updated live_* values change constantly — refresh the HUD silently.
    void refreshHud();
  } else if (!telemetryOnly && summaryKey !== undefined && summaryValue !== undefined && settingRows.has(String(summaryKey))) {
    log(`WS ${event.type}: ${summaryKey}=${summaryValue}`);
  } else if (!telemetryOnly) {
    log(`WS ${event.type} changed: ${signature.length > 120 ? `${signature.slice(0, 120)}…` : signature}`);
  }

  if (event.type === 'camera-status-changed') void refreshStatus();
  if (event.type === 'recording-started') setRecordingUi(true);
  if (event.type === 'recording-stopped') setRecordingUi(false);
  // RecUpdateDur: {index:1, value:N}. A tick > 0 advances the overlay clock;
  // a 0 value means recording just ended (mirrors the reference gate).
  if (event.type === 'recording-duration') {
    if (Number(event.payload?.index) === 1) {
      const seconds = Number(event.payload?.value ?? 0);
      if (seconds > 0) updateRecordDuration(seconds); else setRecordingUi(false);
    }
  }
  if (event.type === 'recording-remaining') {
    const seconds = Number(event.payload?.value ?? event.payload?.msg ?? 0);
    updateRecordRemain(seconds);
    // Keep the record/photo gate live: a full card disables starting a new clip.
    recordRemainSeconds = seconds;
    applyRecordGate($('#record').classList.contains('recording'));
  }
  if (event.type === 'recording-file') updateRecordFile(String(event.payload?.value ?? ''));
  if (event.type === 'temperature') $('#hud-temp').textContent = `${event.payload.value ?? '-'}°C`;
  if (event.type === 'camera-shutdown') log('Camera unavailable');
  // AF-area / mode changes move or reshape the on-preview focus frame.
  if (event.type === 'config-changed') {
    const key = event.payload?.key ?? event.payload?.config_key ?? event.payload?.k;
    if (key !== undefined && AF_ROI_KEYS.has(String(key))) void refreshAfRoi();
  }
  // UpdateAfArea reports the focus box as {roi_x, roi_y, roi_w, roi_h} — the
  // top-left corner + size on a 0-1 scale. Draw it directly.
  if (event.type === 'af-area-changed') {
    const p = event.payload ?? {};
    const x = Number(p.roi_x), y = Number(p.roi_y), w = Number(p.roi_w), h = Number(p.roi_h);
    if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) showAfRoiFromSocket(x, y, w, h);
  }
  if (event.type === 'basic-info' && event.payload) applyBasicInfo(event.payload as Record<string, unknown>);
});
// The camera layer invalidates cached values for the keys a WS event touches;
// the renderer refreshes exactly those rows (plus dependent groups) — it
// never decides freshness itself.
window.cameraApp.onSettingsStale((update: any) => {
  const address = String(update?.address ?? '');
  if (displayAddress && address && addressKey(address) !== addressKey(displayAddress)) return;
  const keys = update?.keys;
  for (const key of Array.isArray(keys) ? keys : []) {
    if (settingRows.has(key)) void refreshSetting(key);
    for (const groupId of DEPENDENT_GROUPS[key] ?? []) loadGroup(groupId, true);
    if (AF_ROI_KEYS.has(key)) void refreshAfRoi();
  }
});
window.cameraApp.onNotificationState((update: { address: string; state: string }) => {
  if (displayAddress && addressKey(update.address) !== addressKey(displayAddress)) return;
  if (update.state !== 'live') log(`Notification: ${update.state}`);
});
// Background connect steps (Digest login, hidden-window page login) report
// progress so the preview area never looks silently hung.
window.cameraApp.onConnectProgress((update: { address: string; message: string }) => {
  if (displayAddress && addressKey(update.address) !== addressKey(displayAddress)) return;
  $('#preview-message').textContent = update.message;
  const status = $('#scan-status');
  if (status) status.textContent = update.message;
});
}

// Surface otherwise-invisible failures instead of a dead UI.
window.addEventListener('unhandledrejection', (event) => log(`Unhandled rejection: ${String(event.reason)}`));
window.addEventListener('error', (event) => log(`Uncaught error: ${event.message}`));

try {
  initWiring();
} catch (error) {
  $('#scan-status').textContent = `Startup error — UI wiring failed: ${String(error)}`;
  log(`Startup error: ${String(error)}`);
}
