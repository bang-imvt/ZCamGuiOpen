/**
 * Settings schema shared by the main process (value store, dependency
 * handling) and the renderer (pure view). Group keys and catalogs mirror
 * the official web UI (controller.min.js / api.js).
 */

export type SettingDef = {
  key: string;
  label: string;
  readOnly?: boolean;
  /** Slider/range values are read with an individual /ctrl/get, not the catalog batch. */
  perKey?: boolean;
  /** Rows backed by custom endpoints instead of /ctrl/set (handled in main). */
  custom?: 'stream-bitrate' | 'rtmp-push';
};

/** Groups with a `catalog` load through one `/ctrl/getbatch?catalog=<name>`. */
export type GroupDef = { id: string; label: string; catalog?: string; settings: SettingDef[]; parent?: string };

export const SETTINGS_GROUPS: GroupDef[] = [
  {
    id: 'exposure', label: 'Exposure', catalog: 'exposure', settings: [
      { key: 'ev_choice', label: 'Exposure EV' },
      { key: 'flicker', label: 'Anti-flicker' },
      { key: 'meter_mode', label: 'Metering mode' },
      { key: 'iris', label: 'Iris' },
      { key: 'iso', label: 'ISO' },
      { key: 'min_iso', label: 'Minimum ISO' },
      { key: 'max_iso', label: 'Maximum ISO' },
      { key: 'iso_ctrl', label: 'ISO control' },
      { key: 'shutter_angle_ctrl', label: 'Shutter mode (time/angle)' },
      { key: 'sht_operation', label: 'Shutter operation' },
      { key: 'eND', label: 'Electronic ND' },
      { key: 'lock_ae_in_rec', label: 'Lock AE in recording' },
      { key: 'ae_speed', label: 'AE speed' },
      { key: 'bl_comp', label: 'Black level compensation' }
    ]
  },
  {
    id: 'white-balance', label: 'White Balance', catalog: 'wb', settings: [
      { key: 'wb', label: 'White balance mode' },
      { key: 'wb_priority', label: 'AWB priority' },
      { key: 'lock_awb_in_rec', label: 'Lock AWB in recording' },
      { key: 'mwb', label: 'Manual Kelvin', perKey: true },
      { key: 'tint', label: 'Tint', perKey: true },
      { key: 'mwb_r', label: 'Expert gain R', perKey: true },
      { key: 'mwb_g', label: 'Expert gain G', perKey: true },
      { key: 'mwb_b', label: 'Expert gain B', perKey: true }
    ]
  },
  {
    id: 'focus', label: 'Focus', catalog: 'lens', settings: [
      { key: 'focus', label: 'Focus method (AF/MF)' },
      { key: 'af_mode', label: 'AF area type' },
      { key: 'caf', label: 'Continuous AF' },
      { key: 'caf_sens', label: 'CAF sensitivity' },
      { key: 'af_area', label: 'AF area size' },
      { key: 'live_caf', label: 'Live CAF' },
      { key: 'mf_mag', label: 'MF assist (standby)' },
      { key: 'mf_recording', label: 'MF assist (recording)' },
      { key: 'af_speed', label: 'AF speed' },
      { key: 'af_adjust_with_ptz', label: 'AF adjust with PTZ' },
      { key: 'zoom_mode', label: 'Zoom mode' },
      { key: 'lens_focus_pos', label: 'Focus position (manual)', perKey: true },
      { key: 'lens_zoom_pos', label: 'Zoom position (manual)', perKey: true },
      { key: 'fz_speed', label: 'F/Z speed', perKey: true }
    ]
  },
  {
    id: 'image', label: 'Image', catalog: 'image', settings: [
      { key: 'lut', label: 'Image profile / LUT' },
      { key: 'sharpness', label: 'Sharpness' },
      { key: 'noise_reduction', label: 'Noise reduction' },
      { key: 'luma_level', label: 'Luma level' },
      { key: 'brightness', label: 'Brightness', perKey: true },
      { key: 'contrast', label: 'Contrast', perKey: true },
      { key: 'saturation', label: 'Saturation', perKey: true },
      { key: 'hue', label: 'Hue', perKey: true }
    ]
  },
  {
    id: 'record', label: 'Record', catalog: 'record', settings: [
      { key: 'resolution', label: 'Resolution' },
      { key: 'project_fps', label: 'Project FPS' },
      { key: 'vfr_ctrl', label: 'VFR control' },
      { key: 'movvfr', label: 'VFR FPS (MOV)' },
      { key: 'record_file_format', label: 'File format' },
      { key: 'rotation', label: 'File rotation' },
      { key: 'split_duration', label: 'Split duration' },
      { key: 'rec_fps', label: 'Recording FPS' },
      { key: 'preroll', label: 'Preroll' },
      { key: 'raw_over_hdmi', label: 'RAW over HDMI' },
      { key: 'rec_frame_indicator', label: 'Recording frame indicator' },
      { key: 'preroll_duration', label: 'Preroll duration' },
      { key: 'video_tl_interval', label: 'Timelapse interval', perKey: true },
      { key: 'record_meta', label: 'Record metadata', perKey: true },
      { key: 'camera_id', label: 'Camera ID', perKey: true },
      { key: 'reelname', label: 'Reel name', perKey: true }
    ]
  },
  {
    id: 'video', label: 'Video', catalog: 'video', settings: [
      { key: 'video_encoder', label: 'Video encoder' },
      { key: 'bitrate_level', label: 'Bitrate level' },
      { key: 'record_mode', label: 'Record mode' },
      { key: 'compose_mode', label: 'Compose mode' },
      { key: 'rec_proxy_file', label: 'Proxy file' },
      { key: 'crop_sensor', label: 'Crop sensor' },
      { key: 'low_jello', label: 'Low jello' },
      { key: 'photo_q', label: 'Photo quality' },
      { key: 'eis_on_off', label: 'EIS' },
      { key: 'vid_rot', label: 'Video rotation' }
    ]
  },
  {
    // Stream parameter keys follow the official web UI (api.js streaming):
    // stream_* via /ctrl/get|set; bitrate via /ctrl/stream_setting, RTSP
    // auth via /ctrl/rtsp, RTMP push via /ctrl/rtmp (custom rows).
    id: 'streaming', label: 'Stream', settings: [
      { key: 'stream_video_encoder', label: 'Stream encoder' },
      { key: 'stream_resolution', label: 'Stream resolution' },
      { key: 'stream_fps', label: 'Stream FPS' },
      { key: 'stream_bitrate', label: 'Bitrate (Mbps)', custom: 'stream-bitrate' },
      { key: 'rtmp_push', label: 'RTMP push', custom: 'rtmp-push' }
    ]
  },
  {
    id: 'audio', label: 'Audio', catalog: 'audio', settings: [
      { key: 'primary_audio', label: 'Audio encoder' },
      { key: 'audio_channel', label: 'Input channel' },
      { key: 'audio_phantom_power', label: 'Phantom power' },
      { key: 'audio_level_display', label: 'Level display' },
      { key: 'ain_gain_type', label: 'Input gain type' },
      { key: 'audio_input_level', label: 'Input level' },
      { key: 'audio_input_gain', label: 'Input gain' },
      { key: 'audio_noise_reduction', label: 'Noise reduction' },
      { key: 'audio_in_l_gain', label: 'Input gain L', perKey: true },
      { key: 'audio_in_r_gain', label: 'Input gain R', perKey: true },
      { key: 'audio_output_gain', label: 'Output gain', perKey: true }
    ]
  },
  {
    id: 'system', label: 'System', catalog: 'system', settings: [
      { key: 'hdmi_fmt', label: 'HDMI format' },
      { key: 'hdmi_osd', label: 'HDMI OSD' },
      { key: 'use_edid', label: 'Use EDID' },
      { key: 'osd_layout', label: 'OSD layout' },
      { key: 'led', label: 'LED' },
      { key: 'desqueeze', label: 'Desqueeze' },
      { key: 'usb_device_role', label: 'USB role' },
      { key: 'tally_on', label: 'Tally brightness' },
      { key: 'ir', label: 'IR' },
      { key: 'ir_id', label: 'IR ID' },
      { key: 'color_bar_enable', label: 'Color bar' },
      { key: 'genlock', label: 'Genlock' },
      { key: 'sdi', label: 'SDI output' },
      { key: '3g_sdi_mode', label: '3G-SDI mode' },
      { key: 'visca_enable', label: 'VISCA enable' },
      { key: 'visca_id', label: 'VISCA ID' },
      { key: 'visca_baud_rate', label: 'VISCA baud rate' },
      { key: 'lcd_backlight', label: 'LCD backlight', perKey: true },
      { key: 'gl_shf_coarse', label: 'Genlock coarse', perKey: true },
      { key: 'gl_shf_fine', label: 'Genlock fine', perKey: true }
    ]
  },
  {
    id: 'maintenance', label: 'Maintenance', catalog: 'maintanence', parent: 'system', settings: [
      { key: 'auto_off', label: 'Auto off' },
      { key: 'auto_standby', label: 'Auto standby' }
    ]
  },
  {
    id: 'ptz', label: 'PTZ', catalog: 'ptz', settings: [
      { key: 'pt_speedmode', label: 'Speed mode' },
      { key: 'ptz_flip', label: 'Flip' },
      { key: 'ptz_limit', label: 'PTZ limit' },
      { key: 'ptz_preset_mode', label: 'Preset recall mode' },
      { key: 'ptz_speed_mode', label: 'Preset recall speed mode' },
      { key: 'freeze_during_preset', label: 'Freeze during preset' },
      { key: 'pt_pwr_pos', label: 'Power-on position' },
      { key: 'pt_priv_mode', label: 'Privacy mode' },
      { key: 'preset_adjust_speed_with_zoom', label: 'Adjust speed with zoom' },
      { key: 'pt_speed_with_zoom_pos', label: 'Speed with zoom position' },
      { key: 'ptz_common_speed_unit', label: 'Common speed unit' },
      { key: 'ptz_common_speed', label: 'Common speed', perKey: true },
      { key: 'ptz_common_time', label: 'Common time', perKey: true }
    ]
  },
  {
    id: 'network', label: 'Network', catalog: 'network', parent: 'system', settings: [
      { key: 'wifi', label: 'Wi-Fi' },
      { key: 'wifi_channel', label: 'Wi-Fi channel' }
    ]
  },
  {
    id: 'security', label: 'Security', catalog: 'security', parent: 'system', settings: [
      { key: 'http_auth', label: 'HTTP auth' },
      { key: 'https_on', label: 'HTTPS' },
      { key: 'https_cert_source', label: 'Certificate source' }
    ]
  },
  {
    id: 'multicam', label: 'Multicam', catalog: 'multicam', parent: 'system', settings: [
      { key: 'union_ae', label: 'Union AE' },
      { key: 'union_awb', label: 'Union AWB' },
      { key: 'ezlink_mode', label: 'EzLink mode' },
      { key: 'ezlink_trigger', label: 'EzLink trigger' }
    ]
  },
  {
    id: 'assist', label: 'Assist Tools', catalog: 'assitool', settings: [
      { key: 'assitool_display', label: 'Assist tools display' },
      { key: 'assitool_scope', label: 'Scope type' },
      { key: 'assitool_peak_onoff', label: 'Zebra/peaking' },
      { key: 'assitool_peak_color', label: 'Peaking color' },
      { key: 'assitool_frame_line', label: 'Frame line' },
      { key: 'assitool_frame_line_color', label: 'Frame line color' },
      { key: 'assitool_center_mark', label: 'Center mark' },
      { key: 'assitool_center_mark_color', label: 'Center mark color' },
      { key: 'assitool_exposure', label: 'Assist exposure' },
      { key: 'assitool_grid_line', label: 'Grid line' },
      { key: 'assitool_safe_area', label: 'Safe area' },
      { key: 'hdmi_focus_area', label: 'HDMI focus area' },
      { key: 'assitool_zera_th1', label: 'Zebra threshold 1', perKey: true },
      { key: 'assitool_zera_th2', label: 'Zebra threshold 2', perKey: true }
    ]
  },
 {
    id: 'timecode', label: 'Timecode', catalog: 'timecode', parent: 'system', settings: [
      { key: 'tc_source', label: 'TC source' },
      { key: 'tc_count_up', label: 'Count-up type' },
      { key: 'tc_hdmi_dispaly', label: 'HDMI display' },
      { key: 'tc_drop_frame', label: 'Drop frame' }
    ]
  }
];

/**
 * Official postSetConfig dependency map: after a successful write these
 * groups must be re-read because their choices/values depend on the new
 * value (e.g. LUT changes ISO ranges, compose_mode changes fps lists).
 */
export const DEPENDENT_GROUPS: Record<string, string[]> = {
  // Reference postSetConfig dependencies (controller.min.js).
  focus: ['focus'],
  caf: ['focus'],
  caf_sens: ['focus'],
  live_caf: ['focus'],
  af_mode: ['focus'],
  af_area: ['focus'],
  af_speed: ['focus'],
  af_adjust_with_ptz: ['focus'],
  mf_mag: ['focus'],
  mf_recording: ['focus'],
  iso: ['exposure'],
  iso_ctrl: ['exposure'],
  min_iso: ['exposure'],
  max_iso: ['exposure'],
  sht_operation: ['exposure'],
  shutter_angle_ctrl: ['exposure'],
  compose_mode: ['record', 'video'],
  movvfr: ['record', 'video'],
  video_encoder: ['record', 'video'],
  record_mode: ['record', 'video'],
  bitrate_level: ['video'],
  resolution: ['record', 'timecode'],
  project_fps: ['record', 'timecode'],
  assitool_peak_onoff: ['assist'],
  assitool_exposure: ['assist'],
  assitool_scope: ['assist'],
  tc_drop_frame: ['timecode'],
  tc_source: ['timecode'],
  audio_channel: ['audio'],
  wb: ['white-balance'],
  mwb: ['white-balance'],
  tint: ['white-balance'],
  lut: ['exposure'],
  vfr_ctrl: ['record'],
  wifi: ['network'],
  https_on: ['security']
};

/** Boolean-ish option pairs used to render on/off selects. */
export const BOOLEAN_PAIRS: Record<string, [string, string]> = {
  on: ['on', 'off'],
  enable: ['enable', 'disable'],
  enabled: ['enabled', 'disabled'],
  yes: ['yes', 'no'],
  true: ['true', 'false'],
  '1': ['1', '0']
};

/** Live HUD telemetry keys (shutter/ISO/EV/WB/iris/fps/resolution/temp). */
export const HUD_KEYS = new Set(['sht_operation', 'live_ae_shutter', 'live_ae_shutter_angle', 'live_ae_iso', 'ev', 'mwb', 'live_ae_fno', 'project_fps', 'resolution']);
