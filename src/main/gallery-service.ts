import { dialog, BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CameraClient } from '../camera/camera-client';
import { GalleryFile, GalleryFolder, GalleryMedia, parseGalleryListing } from '../shared/gallery';

function segment(value: string, label: string): string {
  const decoded = decodeURIComponent(String(value ?? '')).trim().replace(/^[/\\]+|[/\\]+$/g, '');
  if (!decoded || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
    throw new Error(`Invalid gallery ${label}`);
  }
  return decoded;
}

function folderPath(folder?: string): string {
  return folder ? `/DCIM/${encodeURIComponent(segment(folder, 'folder'))}/` : '/DCIM/';
}

export class GalleryService {
  constructor(private readonly client: CameraClient) {}

  async listFolders(): Promise<GalleryFolder[]> {
    const body = await this.client.http.getText('/DCIM/');
    return parseGalleryListing(parseBody(body), '/DCIM', true) as GalleryFolder[];
  }

  async listFiles(folder: string): Promise<GalleryFile[]> {
    const safeFolder = segment(folder, 'folder');
    const body = await this.client.http.getText(folderPath(safeFolder));
    return parseGalleryListing(parseBody(body), `/DCIM/${encodeURIComponent(safeFolder)}`, false) as GalleryFile[];
  }

  readMedia(folder: string, file: string): Promise<GalleryMedia> {
    const safeFolder = segment(folder, 'folder');
    const safeFile = segment(file, 'file');
    return this.client.http.getBytes(`/DCIM/${encodeURIComponent(safeFolder)}/${encodeURIComponent(safeFile)}`);
  }

  async saveMedia(owner: BrowserWindow | undefined, folder: string, file: string, suggestedName?: string): Promise<{ canceled: boolean; savedPath?: string }> {
    const safeFile = segment(file, 'file');
    const media = await this.readMedia(folder, safeFile);
    const defaultName = safeSaveName(suggestedName || safeFile, safeFile);
    const options = {
      title: 'Save camera media',
      defaultPath: path.join(os.homedir(), 'Downloads', defaultName),
      buttonLabel: 'Save',
      filters: media.contentType.startsWith('image/') ? [{ name: 'Image', extensions: [extension(defaultName, 'jpg')] }] : media.contentType.startsWith('video/') ? [{ name: 'Video', extensions: [extension(defaultName, 'mp4')] }] : [{ name: 'All files', extensions: ['*'] }]
    };
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { canceled: true };
    await writeFile(result.filePath, Buffer.from(media.data));
    return { canceled: false, savedPath: result.filePath };
  }
}

function safeSaveName(value: string, fallback: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[ .]+$/, '').trim();
  return cleaned || fallback;
}
function extension(name: string, fallback: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match?.[1] ?? fallback;
}

function parseBody(body: string): unknown {
  try { return JSON.parse(body); } catch { return body; }
}
