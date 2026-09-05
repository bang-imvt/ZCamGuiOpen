import { DEPENDENT_GROUPS, SETTINGS_GROUPS, type GroupDef } from '../shared/settings-schema';
import type { CameraClient } from './camera-client';
import type { StoredSetting } from './camera-state';

export type SettingsSnapshot = {
  groupId: string;
  revision: number;
  values: Record<string, StoredSetting>;
  visibleKeys: string[];
  disabledKeys: string[];
  errors: Record<string, string>;
};

type Listener = (snapshot: SettingsSnapshot) => void;

/** Background settings orchestration: the renderer only receives snapshots. */
export class SettingsEngine {
  private readonly revisions = new Map<string, number>();
  private readonly pending = new Map<string, Promise<SettingsSnapshot>>();
  private listener?: Listener;

  constructor(private readonly client: CameraClient) {}

  onSnapshot(listener: Listener): () => void {
    this.listener = listener;
    return () => { if (this.listener === listener) this.listener = undefined; };
  }

  async loadGroup(groupId: string, force = false): Promise<SettingsSnapshot> {
    const group = SETTINGS_GROUPS.find((item) => item.id === groupId);
    if (!group) throw new Error(`Unknown settings group: ${groupId}`);
    const existing = this.pending.get(groupId);
    if (existing && !force) return existing;
    const revision = (this.revisions.get(groupId) ?? 0) + 1;
    this.revisions.set(groupId, revision);
    const task = this.fetchGroup(group, revision);
    this.pending.set(groupId, task);
    try {
      const snapshot = await task;
      if (this.revisions.get(groupId) === revision) this.listener?.(snapshot);
      return snapshot;
    } finally {
      if (this.pending.get(groupId) === task) this.pending.delete(groupId);
    }
  }

  async write(key: string, value: string): Promise<SettingsSnapshot[]> {
    await this.client.writeSetting(key, value);
    const groups = new Set(DEPENDENT_GROUPS[key] ?? []);
    const defGroup = SETTINGS_GROUPS.find((group) => group.settings.some((setting) => setting.key === key));
    if (defGroup) groups.add(defGroup.id);
    return Promise.all([...groups].map((groupId) => this.loadGroup(groupId, true)));
  }

  async refreshKeys(keys: string[]): Promise<SettingsSnapshot[]> {
    const groups = new Set<string>();
    for (const key of keys) {
      const group = SETTINGS_GROUPS.find((item) => item.settings.some((setting) => setting.key === key));
      if (group) groups.add(group.id);
      for (const dependent of DEPENDENT_GROUPS[key] ?? []) groups.add(dependent);
    }
    return Promise.all([...groups].map((groupId) => this.loadGroup(groupId, true)));
  }

  private async fetchGroup(group: GroupDef, revision: number): Promise<SettingsSnapshot> {
    const definitions = group.settings.filter((setting) => !setting.custom);
    const errors: Record<string, string> = {};
    if (group.catalog) {
      try { await this.client.fetchCatalog(group.catalog); }
      catch (error) { errors[group.id] = error instanceof Error ? error.message : String(error); }
    }
    for (const definition of definitions) {
      const cached = this.client.state.get(definition.key);
      if (cached && !definition.perKey) continue;
      try { await this.client.fetchSetting(definition.key); }
      catch (error) { errors[definition.key] = error instanceof Error ? error.message : String(error); }
    }
    const values = this.client.state.getMany(definitions.map((definition) => definition.key));
    const visibleKeys: string[] = [];
    let disabledKeys: string[] = [];
    for (const definition of definitions) {
      const value = values[definition.key];
      if (!value || value.code !== undefined && value.code !== 0 || value.value === undefined || value.value === null || value.value === '') {
        if (!errors[definition.key]) errors[definition.key] = 'Unsupported by camera';
        continue;
      }
      // Focus/zoom position sliders only make sense when the camera exposes them
      // as writable (ro != 1), matching the reference focusShow/zoomShow rules.
      if ((definition.key === 'lens_focus_pos' || definition.key === 'lens_zoom_pos') && (value.ro || definition.readOnly)) continue;
      visibleKeys.push(definition.key);
      if (definition.readOnly || value.ro) disabledKeys.push(definition.key);
    }
    // White balance: the reference enables CCT/tint only in Manual and expert
    // RGB gains only in Expert — regardless of the raw `ro` some firmware sends.
    if (group.id === 'white-balance') {
      const mode = String(values.wb?.value ?? '').toLowerCase();
      if (mode.includes('manual')) {
        for (const key of ['mwb', 'tint']) {
          if (values[key] && !visibleKeys.includes(key)) visibleKeys.push(key);
        }
        disabledKeys = disabledKeys.filter((key) => key !== 'mwb' && key !== 'tint');
      } else if (mode.includes('expert')) {
        for (const key of ['mwb_r', 'mwb_g', 'mwb_b']) {
          if (values[key] && !visibleKeys.includes(key)) visibleKeys.push(key);
        }
        disabledKeys = disabledKeys.filter((key) => key !== 'mwb_r' && key !== 'mwb_g' && key !== 'mwb_b');
      }
    }
    return { groupId: group.id, revision, values, visibleKeys, disabledKeys, errors };
  }
}
