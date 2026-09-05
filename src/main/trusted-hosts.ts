// Camera hosts whose self-signed TLS certificates we accept. Populated when
// a camera is connected — and, importantly, during discovery probes, so an
// HTTPS-only camera answers before it was ever "connected".
const trusted = new Set<string>();

export function trustCameraHost(host: string): void {
  if (host) trusted.add(host);
}

export function isTrustedCameraHost(host: string): boolean {
  return !!host && trusted.has(host);
}
