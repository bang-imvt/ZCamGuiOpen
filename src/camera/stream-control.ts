/**
 * Streaming controls behind the Stream page. Endpoints and units mirror the
 * official web UI (js/api.js streaming + controller.min.js). The camera layer
 * returns snapshots; the renderer only renders them.
 */
import { CameraHttpTransport } from './http-transport';
import { CameraState } from './camera-state';

export type StreamState = {
  /** Stream index this snapshot describes ("stream1", "stream2", ...). */
  index: string;
  bitrateMbps?: number;
  /** Raw bitrate field as the camera reports it (kbps units per the reference). */
  bitrateRaw?: number;
  bitrateRo?: boolean;
  encoderType?: string;
  streamStatus?: string;
  rtmp?: { url: string; key: string; busy: boolean };
  /** Rows/areas the camera does not support (query failed) — renderer hides them. */
  supported: { bitrate: boolean; rtmp: boolean };
  /** Full raw response of /ctrl/stream_setting?action=query — kept for inspection. */
  detail?: Record<string, unknown>;
};

type QueryResponse = { code?: number; desc?: string } & Record<string, unknown>;

/**
 * The reference maps a numeric index to "stream${index}". A literal "stream1"
 * is kept as-is; the default is "stream1".
 */
function streamIndex(index?: string): string {
  const raw = String(index ?? 'stream1');
  return /^\d+$/.test(raw) ? `stream${raw}` : raw;
}

export class StreamControl {
  constructor(private readonly http: CameraHttpTransport, private readonly state: CameraState) {}

  private async request<T = QueryResponse>(path: string): Promise<T> {
    return await this.http.get<T>(path);
  }

  private ok(response: QueryResponse | undefined): response is QueryResponse & { code?: 0 } {
    // This firmware omits `code` on successful stream snapshots.
    return !!response && (response.code === undefined || Number(response.code) === 0);
  }

  /** Reads all stream endpoints; unsupported ones report `supported=false`. */
  async query(index = 'stream1'): Promise<StreamState> {
    const state: StreamState = { index, supported: { bitrate: false, rtmp: false } };

    try {
      const query = await this.request(`/ctrl/stream_setting?action=query&index=${encodeURIComponent(streamIndex(index))}`);
      if (!this.ok(query) || typeof query.bitrate !== 'number') throw new Error(String(query?.desc ?? 'no bitrate'));
      // Keep the whole structured response (bitwidth, gop_n, rotation, ...).
      this.state.setResource(`stream_setting:${streamIndex(index)}`, query);
      state.detail = query;
      state.bitrateRaw = Number(query.bitrate);
      state.bitrateMbps = Math.round((Number(query.bitrate) / 1e3) * 10) / 10;
      state.bitrateRo = query.bitrateRo === true || query.bitrateRo === 1 || query.bitrateRo === '1';
      state.encoderType = typeof query.encoderType === 'string' ? query.encoderType : undefined;
      state.streamStatus = typeof query.status === 'string' ? query.status : undefined;
      state.supported.bitrate = true;
    } catch { /* row hidden */ }

    try {
      const query = await this.request(`/ctrl/rtmp?action=query&index=index0`);
      if (!this.ok(query)) throw new Error('no rtmp');
      state.rtmp = {
        url: String(query.url ?? ''),
        key: String(query.key ?? ''),
        busy: String(query.status ?? 'idle') === 'busy'
      };
      state.supported.rtmp = true;
      // Official updateVisibility: RTMP UI only makes sense for h264 streams.
      // Encoder labels vary ("h264", "H.264", "H264") — compare case-insensitively.
      if (state.encoderType && !/h\.?264/i.test(state.encoderType)) state.supported.rtmp = false;
    } catch { /* row hidden */ }

    return state;
  }

  /**
   * This camera reports and accepts bitrate in kbps while the UI value is Mbps.
   * Query display and writes therefore both use a ×1e3 conversion.
   * Raw mode writes the value unchanged.
   */
  async setBitrate(value: number, index = 'stream1', mode: 'mbps' | 'raw' = 'mbps'): Promise<void> {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid bitrate: ${value}`);
    const bitrate = mode === 'mbps' ? Math.round(value * 1e3) : Math.round(value);
    const response = await this.request(`/ctrl/stream_setting?index=${encodeURIComponent(streamIndex(index))}&bitrate=${bitrate}`);
    if (!this.ok(response)) throw new Error(String(response.desc ?? `code ${response.code}`));
    this.state.markStaleResource(`stream_setting:${streamIndex(index)}`);
  }

  /** Reference: URL and key are optional; stop always targets `index0`. */
  async startRtmp(url?: string, key?: string): Promise<void> {
    const search = new URLSearchParams({ action: 'start' });
    if (url) search.set('url', url);
    if (key) search.set('key', key);
    const response = await this.request(`/ctrl/rtmp?${search.toString()}`);
    if (!this.ok(response)) throw new Error(String(response.desc ?? `code ${response.code}`));
  }

  async stopRtmp(): Promise<void> {
    const response = await this.request('/ctrl/rtmp?action=stop&index=index0');
    if (!this.ok(response)) throw new Error(String(response.desc ?? `code ${response.code}`));
  }
}