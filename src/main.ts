import { app, BrowserWindow, Menu, MessageChannelMain, ipcMain, net, session } from 'electron';
import path from 'node:path';
import { CameraHttpTransport } from './camera/http-transport';
import { CameraManager } from './main/camera-manager';
import { discoverCameras, listNetworkInterfaces } from './main/discovery';
import { isTrustedCameraHost, trustCameraHost } from './main/trusted-hosts';
import { CameraCandidate, CameraCredentials } from './shared/types';
import { GalleryService } from './main/gallery-service';

// Startup stamp so a stale build/process is instantly recognizable in the
// console (compare with the LastWriteTime of app/main.js).
console.log(`[main] build stamp ${__dirname} ${new Date().toISOString()}`);

let mainWindow: BrowserWindow | undefined;
const cameraManager = new CameraManager();

// Z CAM firmware serves HTTPS with a self-signed certificate (its own web
// page works because the browser was told to trust it once). Renderer-side
// <img>/<video>/fetch previews would fail with ERR_CERT_AUTHORITY_INVALID
// (-202), so we allow self-signed certs for camera hosts only — never
// globally.
app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* malformed URL — reject below */ }
  if (isTrustedCameraHost(host)) {
    event.preventDefault();
    callback(true);
    return;
  }
  callback(false);
});

// `certificate-error` alone does not cover every network path (e.g. some
// WebSocket and net-module handshakes bypass it). The verify proc below runs
// for every TLS connection in the default session — renderer fetch/img/WebRTC
// and main-process requests alike.
function registerCertificateVerifyProc(): void {
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    callback(isTrustedCameraHost(request.hostname) ? 0 : -2);
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  void window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow = window;
}

ipcMain.handle('camera:interfaces', () => listNetworkInterfaces());
ipcMain.handle('camera:discover', (_event, timeoutMs?: number, interfaceAddress?: string) => discoverCameras(timeoutMs, interfaceAddress));
// Manual entry for cameras mDNS cannot see: probe /info over https/http.
// A 401 answer still proves the control API exists — report it as available.
ipcMain.handle('camera:probe-address', async (_event, rawAddress: string) => {
  const host = String(rawAddress ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  if (!/^[a-zA-Z0-9._-]+$/.test(host)) return { reachable: false, name: host, probeError: 'invalid IP or hostname' };
  trustCameraHost(host);
  const transport = new CameraHttpTransport(host, undefined, 4_000);
  try {
    const info = await transport.get<Record<string, unknown>>('/info');
    const pick = (...keys: string[]): string => {
      for (const key of keys) { const value = info?.[key]; if (typeof value === 'string' && value.trim()) return value.trim(); }
      return '';
    };
    return { reachable: true, name: pick('cameraName', 'nickName', 'model') || host };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Rejected credentials still mean a camera control API lives there.
    if (/401|403/.test(message)) return { reachable: true, name: host, probeError: 'Requires authentication (HTTP 401)' };
    return { reachable: false, name: host, probeError: message };
  }
});

cameraManager.onEvent(({ address, update }) => {
  mainWindow?.webContents.send('camera:event', { address, ...update });
  if (update.changedKeys.length) mainWindow?.webContents.send('camera:settings-stale', { address, keys: update.changedKeys });
});
cameraManager.onState(({ address, state }) => mainWindow?.webContents.send('camera:notification-state', { address, state }));
cameraManager.onProgress(({ address, message }) => mainWindow?.webContents.send('camera:connect-progress', { address, message }));
cameraManager.onSnapshot(({ address, snapshot }) => mainWindow?.webContents.send('camera:settings-snapshot', { address, snapshot }));

ipcMain.handle('camera:connect', async (_event, candidate: CameraCandidate, credentials?: CameraCredentials, forcedScheme?: string) => {
  trustCameraHost(candidate.address);
  try {
    const result = await cameraManager.connect(candidate, credentials, forcedScheme, 8_000);
    mainWindow?.webContents.send('camera:active-changed', { address: candidate.address, ok: true });
    return { candidate, ...result };
  } catch (error) {
    const reason = error instanceof Error && error.message ? error.message : String(error);
    throw new Error(`Cannot reach ${candidate.address}: ${reason || 'no response'}`);
  }
});
ipcMain.handle('camera:activate', (_event, address: string) => {
  const ok = cameraManager.activate(address);
  if (ok) mainWindow?.webContents.send('camera:active-changed', { address, ok: true });
  return ok;
});
ipcMain.handle('camera:disconnect', (_event, address?: string) => cameraManager.disconnect(address));
ipcMain.handle('camera:status', () => cameraManager.active?.getStatus());
ipcMain.handle('camera:recording-status', () => cameraManager.active?.getRecordingStatus());
ipcMain.handle('camera:recording-remain', () => cameraManager.active?.getRecordingRemain());
ipcMain.handle('camera:start-recording', () => cameraManager.active?.startRecording());
ipcMain.handle('camera:stop-recording', () => cameraManager.active?.stopRecording());
ipcMain.handle('camera:capture-photo', () => cameraManager.active?.capturePhoto());
ipcMain.handle('camera:card-present', () => cameraManager.active?.cardPresent());
ipcMain.handle('camera:lens-action', (_event, action: string, speed?: number) => {
  const client = cameraManager.active;
  if (!client) throw new Error('Not connected');
  const actions: Record<string, () => Promise<unknown>> = {
    focusnear: () => client.focusNear(speed), focusfar: () => client.focusFar(speed), focusstop: () => client.focusStop(),
    zoomin: () => client.zoomIn(speed), zoomout: () => client.zoomOut(speed), zoomstop: () => client.zoomStop(),
    f_status: () => client.focusStatus(), z_status: () => client.zoomStatus(), af: () => client.onePushAf()
  };
  const handler = actions[String(action)];
  if (!handler) throw new Error(`Unsupported lens action: ${action}`);
  return handler();
});
ipcMain.handle('camera:lens-roi', (_event, action: 'query' | 'update', x?: number, y?: number) => {
  const client = cameraManager.active;
  if (!client) throw new Error('Not connected');
  return action === 'query' ? client.getRoi() : client.updateRoiCenter(Number(x), Number(y));
});
ipcMain.handle('camera:get-setting', (_event, key: string) => cameraManager.active?.fetchSetting(key));
ipcMain.handle('camera:get-catalog', (_event, catalog: string) => cameraManager.active?.fetchCatalog(catalog));
// Cached values only — no network. The renderer uses this to render rows
// from the state store and to decide which keys still need a fetch.
ipcMain.handle('camera:get-settings-state', (_event, keys: string[]) => {
  if (!Array.isArray(keys)) return {};
  return cameraManager.active?.state.getMany(keys.slice(0, 200)) ?? {};
});
ipcMain.handle('camera:load-settings-group', (_event, groupId: string, force?: boolean) => cameraManager.active?.settings.loadGroup(groupId, Boolean(force)));
ipcMain.handle('camera:set-setting', async (_event, key: string, value: string) => {
  const client = cameraManager.active;
  if (!client) throw new Error('Not connected');
  return client.settings.write(String(key), String(value));
});
// Streaming endpoints (stream_setting / rtmp) are driven through the typed
// StreamControl — the renderer receives snapshots, not raw endpoints.
ipcMain.handle('camera:stream-state', (_event, index?: string) => cameraManager.active?.stream.query(index));
ipcMain.handle('camera:stream-set-bitrate', async (_event, value: number, index?: string, mode?: 'mbps' | 'raw') => {
  const client = cameraManager.active;
  if (!client) throw new Error('Not connected');
  await client.stream.setBitrate(Number(value), index, mode);
  return client.stream.query(index);
});
ipcMain.handle('camera:stream-rtmp', async (_event, action: 'start' | 'stop', url?: string, key?: string) => {
  const client = cameraManager.active;
  if (!client) throw new Error('Not connected');
  if (action === 'start') await client.stream.startRtmp(url ? String(url) : undefined, key ? String(key) : undefined);
  else await client.stream.stopRtmp();
  return client.stream.query();
});
ipcMain.handle('camera:gallery-folders', () => {
  const client = cameraManager.active;
  if (!client) throw new Error('Not connected');
  return new GalleryService(client).listFolders();
});
ipcMain.handle('camera:gallery-files', (_event, folder: string) => {
  const client = cameraManager.active;
  if (!client) throw new Error('Not connected');
  return new GalleryService(client).listFiles(String(folder));
});
ipcMain.handle('camera:gallery-media', (_event, folder: string, file: string) => {
  const client = cameraManager.active;
  if (!client) throw new Error('Not connected');
  return new GalleryService(client).readMedia(String(folder), String(file));
});
ipcMain.handle('camera:gallery-save', (event, folder: string, file: string, suggestedName?: string) => {
  const client = cameraManager.active;
  if (!client) throw new Error('Not connected');
  const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  return new GalleryService(client).saveMedia(owner, String(folder), String(file), String(suggestedName ?? file));
});
// WebRTC signaling proxy. The renderer page is loaded from file://, where
// direct fetch() to the camera's webrtc-streamer (http://<ip>:8000) is
// blocked by CORS/mixed-content rules; the official web UI has no such
// restriction because it is served from the camera itself. Requests are
// restricted to the connected camera's host.
ipcMain.handle('camera:webrtc-request', async (_event, opts: { url: string; method?: string; body?: string }) => {
  const client = cameraManager.active;
  if (!client) throw new Error('Not connected');
  const target = new URL(opts.url);
  if (target.hostname !== client.http.address) throw new Error(`Blocked webrtc request to ${target.hostname}`);
  try {
    // credentials:'include' so the post-login session cookie rides along on
    // every signaling call (webrtc-streamer may sit behind http_auth too).
    const response = await net.fetch(opts.url, { method: opts.method ?? 'GET', body: opts.body, credentials: 'include' });
    return { ok: response.ok, status: response.status, text: await response.text() };
  } catch (error) {
    // Refused/reset ports are expected while probing signaling endpoints —
    // return them as results instead of throwing (an ipcMain throw logs to
    // the Electron console on every retry).
    return { ok: false, status: 0, text: `network error: ${error instanceof Error ? error.message : String(error)}` };
  }
});
// Fetches the camera's own web UI entry page so the renderer can detect
// which streaming mechanism this firmware actually uses (the official page
// demonstrably shows video — its source is the ground truth).
ipcMain.handle('camera:probe-stream', async () => {
  const client = cameraManager.active;
  if (!client) throw new Error('Not connected');
  const host = client.http.address;
  const urls = [`http://${host}/www/index.html`, `http://${host}/`, `https://${host}/www/index.html`];
  for (const url of urls) {
    try {
      const response = await net.fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return { url, text: (await response.text()).slice(0, 40000) };
    } catch { /* try the next candidate */ }
  }
  return null;
});

// Diagnostic probe for stream URLs the renderer's <img> cannot explain
// (img.onerror carries no status). Restricted to the connected camera.
ipcMain.handle('camera:probe-url', async (_event, rawUrl: string) => {
  const client = cameraManager.active;
  if (!client) throw new Error('Not connected');
  const target = new URL(rawUrl);
  if (target.hostname !== client.http.address) throw new Error(`Blocked probe to ${target.hostname}`);
  try {
    const response = await net.fetch(target.toString(), { signal: AbortSignal.timeout(5000) });
    return { status: response.status, contentType: response.headers.get('content-type') ?? '' };
  } catch (error) {
    return { status: 0, contentType: '', error: error instanceof Error ? error.message : String(error) };
  }
});

// MJPEG proxy stream. The renderer (file:// origin) cannot load the camera's
// multipart stream in an <img> (mixed-content / credential rules), but the
// main process can: net.fetch shares the session cookies (post-login) and the
// camera-host certificate bypass. Raw chunks are forwarded over a
// MessagePort; the renderer reassembles JPEG frames (SOI/EOI markers).
ipcMain.handle('camera:mjpeg-start', async (event, url: string) => {
  const target = new URL(url);
  if (!isTrustedCameraHost(target.hostname)) throw new Error(`Blocked mjpeg stream to ${target.hostname}`);
  const portPair = new MessageChannelMain();
  event.sender.postMessage('camera:mjpeg-port', null, [portPair.port1]);
  try {
    // Connect-only timeout: abort if headers never arrive within 10s, but
    // clear it once the response starts — an established multipart stream
    // must live forever, AbortSignal.timeout would kill the body 10s in and
    // force a pointless reconnect loop.
    const connectAbort = new AbortController();
    const connectTimer = setTimeout(() => connectAbort.abort(), 10_000);
    let response: Awaited<ReturnType<typeof net.fetch>>;
    try {
      response = await net.fetch(target.toString(), { signal: connectAbort.signal, credentials: 'include' });
    } finally {
      clearTimeout(connectTimer);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok || !response.body) {
      portPair.port2.postMessage({ type: 'error', status: response.status, contentType });
      portPair.port2.close();
      return { ok: false, status: response.status, contentType };
    }
    // A 200 that is not a stream (HTML login page, JSON error…) would sit
    // silent until the renderer timeout — fail fast and report a body sample
    // so the Debug panel shows what the camera actually answered.
    if (contentType && !/multipart|image|octet-stream/i.test(contentType)) {
      const reader = response.body.getReader();
      const first = await reader.read().catch(() => ({ value: undefined as Uint8Array | undefined }));
      void reader.cancel().catch(() => undefined);
      const sample = first.value ? new TextDecoder().decode(first.value.slice(0, 200)).replace(/\s+/g, ' ') : '';
      portPair.port2.postMessage({ type: 'error', status: response.status, message: `not a stream — ${contentType || 'no content-type'}: ${sample.slice(0, 150)}` });
      portPair.port2.close();
      return { ok: false, status: response.status, contentType };
    }
    portPair.port2.postMessage({ type: 'start', contentType });
    const reader = response.body.getReader();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          portPair.port2.postMessage({ type: 'chunk', chunk: value });
        }
        portPair.port2.postMessage({ type: 'end' });
      } catch (error) {
        portPair.port2.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      } finally {
        portPair.port2.close();
      }
    })();
    portPair.port2.on('close', () => { void reader.cancel().catch(() => undefined); });
    return { ok: true, status: response.status, contentType };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    portPair.port2.postMessage({ type: 'error', message });
    portPair.port2.close();
    return { ok: false, status: 0, contentType: '', error: message };
  }
});

// Inspect how a camera's web login works. The 401 from /info (redirects
// followed manually, not automatically) carries the definitive answer: a
// WWW-Authenticate header means Basic/Digest; a redirect to login.html means
// the web UI uses its own form. Logged to Debug — never any credentials.
ipcMain.handle('camera:probe-login', async (_event, address: string) => {
  const out: Record<string, unknown> = { address };
  trustCameraHost(address);

  for (const scheme of ['https', 'http']) {
    try {
      // /login/ is where the auth challenge lives (/info is public). The
      // challenge header is the non-standard "WWW-Authenticate-X" — the plain
      // name is a forbidden response header for the fetch API, which is
      // exactly why the firmware renamed it.
      const login = await net.fetch(`${scheme}://${address}/login/`, { redirect: 'manual', signal: AbortSignal.timeout(4000) });
      out.scheme = scheme;
      out.loginStatus = login.status;
      out.wwwAuthenticate = login.headers.get('www-authenticate-x') ?? login.headers.get('www-authenticate') ?? undefined;
      break;
    } catch (error) {
      out.loginError = String(error);
    }
  }

  for (const scheme of ['https', 'http']) {
    try {
      const root = await net.fetch(`${scheme}://${address}/`, { redirect: 'manual', signal: AbortSignal.timeout(4000) });
      out.rootStatus = root.status;
      out.redirectTo = root.headers.get('location') ?? undefined;
      break;
    } catch { /* scheme already recorded above */ }
  }

  for (const scheme of ['https', 'http']) {
    try {
      const page = await net.fetch(`${scheme}://${address}/www/html/login.html`, { signal: AbortSignal.timeout(4000) });
      if (!page.ok) continue;
      const html = await page.text();
      out.loginFormAction = /<form[^>]*action="([^"]*)"/i.exec(html)?.[1] ?? '(no form)';
      out.loginInputs = [...html.matchAll(/<input[^>]*>/gi)]
        .map((tag) => /name="([^"]*)"/i.exec(tag[0])?.[1])
        .filter((name): name is string => !!name);
      const scripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi)].map((match) => match[1]);
      out.loginScripts = scripts;
      // The form is JS-driven (login.min.js), so mine the page and its
      // scripts for the endpoint the login request is actually sent to —
      // and capture the script text itself, since endpoints may be built
      // dynamically instead of appearing as plain string literals.
      const endpoints = new Set<string>();
      for (const match of html.matchAll(/['"`](\/[^'"`\s]{2,100})['"`]/g)) {
        if (/login|auth|session|cgi|api|user|token/i.test(match[1])) endpoints.add(match[1]);
      }
      const scriptTexts: string[] = [];
      for (const src of scripts.slice(0, 4)) {
        try {
          const jsUrl = new URL(src, `${scheme}://${address}/www/html/login.html`).toString();
          const js = await net.fetch(jsUrl, { signal: AbortSignal.timeout(4000) });
          if (!js.ok) continue;
          const text = await js.text();
          for (const match of text.matchAll(/['"`](\/[^'"`\s]{2,100})['"`]/g)) {
            if (/login|auth|session|cgi|api|user|token/i.test(match[1])) endpoints.add(`${src} → ${match[1]}`);
          }
          if (/login/i.test(src)) scriptTexts.push(`${src}\n${text.slice(0, 30000)}`);
        } catch { /* skip unreachable script */ }
      }
      out.candidateEndpoints = [...endpoints];
      out.loginScript = scriptTexts.join('\n----\n').slice(0, 40000);
      out.loginHtml = html.slice(0, 20000);
      break;
    } catch { /* try the next scheme */ }
  }

  return out;
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerCertificateVerifyProc(); // After ready — the session module requires it.
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  void cameraManager.closeAll();
  if (process.platform !== 'darwin') app.quit();
});
