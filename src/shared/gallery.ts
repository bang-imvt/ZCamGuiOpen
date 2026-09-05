export type GalleryItemKind = 'folder' | 'image' | 'video' | 'file';

export type GalleryFolder = {
  name: string;
  path: string;
  modified?: string;
};

export type GalleryFile = {
  name: string;
  path: string;
  kind: Exclude<GalleryItemKind, 'folder'>;
  size?: number;
  modified?: string;
  contentType?: string;
};

export type GalleryMedia = {
  data: Uint8Array;
  contentType: string;
};

const IMAGE_EXTENSIONS = /\.(?:jpg|jpeg|png|gif|webp|heic|tif|tiff)$/i;
const VIDEO_EXTENSIONS = /\.(?:mp4|mov|m4v|avi|mkv|mts|m2ts)$/i;

export function classifyGalleryFile(name: string): GalleryFile['kind'] {
  if (IMAGE_EXTENSIONS.test(name)) return 'image';
  if (VIDEO_EXTENSIONS.test(name)) return 'video';
  return 'file';
}

export function normalizeGalleryName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = decodeURIComponent(value.trim().replace(/^[/\\]+|[/\\]+$/g, ''));
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) return undefined;
  return name;
}

export function parseGalleryListing(body: unknown, basePath: string, folders: boolean): GalleryFolder[] | GalleryFile[] {
  const items: Array<Record<string, unknown> | string> = [];
  if (Array.isArray(body)) items.push(...body);
  else if (body && typeof body === 'object') {
    const object = body as Record<string, unknown>;
    const nested = object.items ?? object.files ?? object.folders ?? object.data ?? object.list;
    if (Array.isArray(nested)) items.push(...nested);
    else for (const [name, value] of Object.entries(object)) items.push({ name, ...(value && typeof value === 'object' ? value as Record<string, unknown> : { value }) });
  } else if (typeof body === 'string') {
    const html = body.match(/href\s*=\s*["']([^"']+)["'][^>]*>([^<]*)/gi) ?? [];
    if (html.length) {
      for (const entry of html) {
        const match = /href\s*=\s*["']([^"']+)["'][^>]*>([^<]*)/i.exec(entry);
        if (match) items.push({ name: match[2].trim() || match[1], href: match[1] });
      }
    } else items.push(...body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  }

  const result = new Map<string, GalleryFolder | GalleryFile>();
  for (const item of items) {
    const record = typeof item === 'string' ? { name: item } : item;
    const rawName = record.name ?? record.filename ?? record.file ?? record.title ?? record.href;
    const name = normalizeGalleryName(String(rawName ?? ''));
    if (!name || /^(?:parent directory|\.\.?\/?|index\.html?)$/i.test(name)) continue;
    const href = typeof record.href === 'string' ? record.href : undefined;
    const isFolder = folders || href?.endsWith('/') || Boolean(record.folder ?? record.isDirectory ?? record.directory);
    const path = `${basePath.replace(/\/$/, '')}/${encodeURIComponent(name)}`;
    if (isFolder) result.set(name, { name, path: `${path}/`, modified: optionalString(record.modified ?? record.date) });
    else result.set(name, {
      name,
      path,
      kind: classifyGalleryFile(name),
      size: optionalNumber(record.size ?? record.bytes ?? record.length),
      modified: optionalString(record.modified ?? record.date ?? record.time),
      contentType: optionalString(record.contentType ?? record.mime ?? record.type)
    });
  }
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function optionalNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}
