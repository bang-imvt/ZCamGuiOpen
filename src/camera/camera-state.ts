/**
 * Per-camera value store — the single place camera settings live.
 *
 * The renderer never keeps camera values: it asks this store (through IPC)
 * for the current snapshot and only triggers fetches for keys that are
 * missing or stale. WebSocket events mark keys stale here; the main process
 * broadcasts the affected keys so the UI refreshes exactly those rows.
 */

export type StoredSetting = {
  key: string;
  /** Raw firmware fields — the renderer decides how to display them. */
  code?: number;
  value?: unknown;
  opts?: unknown[];
  min?: number;
  max?: number;
  step?: number;
  ro?: boolean;
  type?: number;
  fetchedAt: number;
};

/** Extracts the setting key a WebSocket event refers to (official shapes vary). */
export function eventSettingKey(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  const key = payload.key ?? payload.config_key ?? payload.k;
  return typeof key === 'string' && key ? key : undefined;
}

export class CameraState {
  private readonly settings = new Map<string, StoredSetting>();
  /**
   * Structured endpoints (/ctrl/stream_setting, /ctrl/rtmp, ...) do not use
   * the flat { code, key, value } shape — their full response objects are
   * kept verbatim here, keyed like "stream_setting:stream1".
   */
  private readonly resources = new Map<string, Record<string, unknown>>();

  /** Stores one /ctrl/get response (flat { code, key, type, ro, value, opts } shape). */
  applySettingResponse(key: string, response: unknown): void {
    if (!response || typeof response !== 'object') return;
    const data = response as Record<string, unknown>;
    this.settings.set(key, {
      key,
      code: typeof data.code === 'number' ? data.code : undefined,
      value: data.value,
      opts: Array.isArray(data.opts) ? data.opts : undefined,
      min: typeof data.min === 'number' ? data.min : undefined,
      max: typeof data.max === 'number' ? data.max : undefined,
      step: typeof data.step === 'number' ? data.step : undefined,
      ro: data.ro === true || data.ro === 1,
      type: typeof data.type === 'number' ? data.type : undefined,
      fetchedAt: Date.now()
    });
  }

  /** Stores a /ctrl/getbatch?catalog=<name> response ({ cfgs: [...] }). */
  applyCatalogResponse(response: unknown): void {
    const cfgs = (response as { cfgs?: unknown[] } | null | undefined)?.cfgs;
    if (!Array.isArray(cfgs)) return;
    for (const entry of cfgs) {
      if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).key === 'string') {
        const key = (entry as Record<string, unknown>).key as string;
        this.applySettingResponse(key, entry);
      }
    }
  }

  /** WS event dropped or a write happened elsewhere — the cached value is no longer trustworthy. */
  markStale(keys: string[]): void {
    for (const key of keys) this.settings.delete(key);
  }

  /** Stores the full response of a structured endpoint (stream_setting etc.). */
  setResource(name: string, value: unknown): void {
    if (value && typeof value === 'object') this.resources.set(name, value as Record<string, unknown>);
  }

  getResource(name: string): Record<string, unknown> | undefined {
    return this.resources.get(name);
  }

  /** Invalidates structured resources — by exact name or a prefix (e.g. "stream_setting:"). */
  markStaleResource(nameOrPrefix: string): void {
    if (this.resources.has(nameOrPrefix)) this.resources.delete(nameOrPrefix);
    else for (const name of [...this.resources.keys()]) if (name.startsWith(nameOrPrefix)) this.resources.delete(name);
  }

  get(key: string): StoredSetting | undefined {
    return this.settings.get(key);
  }

  getMany(keys: readonly string[]): Record<string, StoredSetting> {
    const out: Record<string, StoredSetting> = {};
    for (const key of keys) {
      const stored = this.settings.get(key);
      if (stored) out[key] = stored;
    }
    return out;
  }

  clear(): void {
    this.settings.clear();
    this.resources.clear();
  }
}
