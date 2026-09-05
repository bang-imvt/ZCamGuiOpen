import { contextBridge, ipcRenderer } from 'electron';
import { CameraCandidate, CameraCredentials } from './shared/types';
import { GalleryFile, GalleryFolder } from './shared/gallery';

contextBridge.exposeInMainWorld('cameraApp', {
  interfaces: () => ipcRenderer.invoke('camera:interfaces'),
  discover: (timeoutMs?: number, interfaceAddress?: string) => ipcRenderer.invoke('camera:discover', timeoutMs, interfaceAddress),
  probeAddress: (address: string) => ipcRenderer.invoke('camera:probe-address', address),
  connect: (candidate: CameraCandidate, credentials?: CameraCredentials, forcedScheme?: string) => ipcRenderer.invoke('camera:connect', candidate, credentials, forcedScheme),
  activate: (address: string) => ipcRenderer.invoke('camera:activate', address),
  disconnect: (address?: string) => ipcRenderer.invoke('camera:disconnect', address),
  status: () => ipcRenderer.invoke('camera:status'),
  recordingStatus: () => ipcRenderer.invoke('camera:recording-status'),
  recordingRemain: () => ipcRenderer.invoke('camera:recording-remain'),
  startRecording: () => ipcRenderer.invoke('camera:start-recording'),
  stopRecording: () => ipcRenderer.invoke('camera:stop-recording'),
  capturePhoto: () => ipcRenderer.invoke('camera:capture-photo'),
  cardPresent: () => ipcRenderer.invoke('camera:card-present'),
  lensAction: (action: string, speed?: number) => ipcRenderer.invoke('camera:lens-action', action, speed),
  lensRoi: (action: 'query' | 'update', x?: number, y?: number) => ipcRenderer.invoke('camera:lens-roi', action, x, y),
  getSetting: (key: string) => ipcRenderer.invoke('camera:get-setting', key),
  getCatalog: (catalog: string) => ipcRenderer.invoke('camera:get-catalog', catalog),
  loadSettingsGroup: (groupId: string, force?: boolean) => ipcRenderer.invoke('camera:load-settings-group', groupId, force),
  onSettingsSnapshot: (listener: (value: { address: string; snapshot: unknown }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: { address: string; snapshot: unknown }) => listener(value);
    ipcRenderer.on('camera:settings-snapshot', handler);
    return () => ipcRenderer.removeListener('camera:settings-snapshot', handler);
  },
  getSettingsState: (keys: string[]) => ipcRenderer.invoke('camera:get-settings-state', keys),
  setSetting: (key: string, value: string) => ipcRenderer.invoke('camera:set-setting', key, value),
  streamState: (index?: string) => ipcRenderer.invoke('camera:stream-state', index),
  streamSetBitrate: (value: number, index?: string, mode?: 'mbps' | 'raw') => ipcRenderer.invoke('camera:stream-set-bitrate', value, index, mode),
  streamRtmp: (action: 'start' | 'stop', url?: string, key?: string) => ipcRenderer.invoke('camera:stream-rtmp', action, url, key),
  listFolders: (): Promise<GalleryFolder[]> => ipcRenderer.invoke('camera:gallery-folders'),
  listGalleryFiles: (folder: string): Promise<GalleryFile[]> => ipcRenderer.invoke('camera:gallery-files', folder),
  readGalleryMedia: (folder: string, file: string): Promise<{ data: Uint8Array; contentType: string }> => ipcRenderer.invoke('camera:gallery-media', folder, file),
  saveGalleryFile: (folder: string, file: string, suggestedName?: string): Promise<{ canceled: boolean; savedPath?: string }> => ipcRenderer.invoke('camera:gallery-save', folder, file, suggestedName),
  webrtcRequest: (opts: { url: string; method?: string; body?: string }) => ipcRenderer.invoke('camera:webrtc-request', opts),
  probeStream: () => ipcRenderer.invoke('camera:probe-stream'),
  probeUrl: (url: string) => ipcRenderer.invoke('camera:probe-url', url),
  // MJPEG proxy stream: main fetches the multipart body (session cookies +
  // certificate bypass apply) and forwards raw chunks over a MessagePort.
  startMjpeg: (url: string) => ipcRenderer.invoke('camera:mjpeg-start', url),
  // A MessagePort passed straight through a contextBridge-proxied callback
  // never fires onmessage in the main world — re-post it via window message
  // so the renderer receives a live port (official isolation-safe pattern).
  onMjpegPort: () => {
    ipcRenderer.on('camera:mjpeg-port', (event) => {
      const port = event.ports[0];
      if (port) window.postMessage({ type: 'camera:mjpeg-port' }, '*', [port]);
    });
  },
  probeLogin: (address: string) => ipcRenderer.invoke('camera:probe-login', address),
  onEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => listener(value);
    ipcRenderer.on('camera:event', handler);
    return () => ipcRenderer.removeListener('camera:event', handler);
  },
  onSettingsStale: (listener: (update: { address: string; keys: string[] }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, update: { address: string; keys: string[] }) => listener(update);
    ipcRenderer.on('camera:settings-stale', handler);
    return () => ipcRenderer.removeListener('camera:settings-stale', handler);
  },
  onNotificationState: (listener: (state: { address: string; state: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: { address: string; state: string }) => listener(value);
    ipcRenderer.on('camera:notification-state', handler);
    return () => ipcRenderer.removeListener('camera:notification-state', handler);
  },
  onActiveChanged: (listener: (value: { address?: string; ok: boolean }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: { address?: string; ok: boolean }) => listener(value);
    ipcRenderer.on('camera:active-changed', handler);
    return () => ipcRenderer.removeListener('camera:active-changed', handler);
  },
  onConnectProgress: (listener: (value: { address: string; message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: { address: string; message: string }) => listener(value);
    ipcRenderer.on('camera:connect-progress', handler);
    return () => ipcRenderer.removeListener('camera:connect-progress', handler);
  }
});
