import { Bonjour, Service } from 'bonjour-service';
import os from 'node:os';
import { CameraCandidate } from '../shared/types';
import { CameraClient } from '../camera/camera-client';
import { trustCameraHost } from './trusted-hosts';

// Legacy service identifiers retained for ZCamera discovery compatibility.
const SERVICE_TYPE = 'eagle';
const SERVICE_LABEL = '_eagle._tcp';

export type NetworkInterface = { name: string; address: string; family: string };

export function listNetworkInterfaces(): NetworkInterface[] {
  // multicast-dns uses IPv4 sockets only, so IPv6 entries cannot be scanned.
  return Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? []).filter((entry) => !entry.internal && entry.family === 'IPv4').map((entry) => ({ name, address: entry.address, family: entry.family }))
  );
}

export async function discoverCameras(timeoutMs = 5_000, interfaceAddress?: string): Promise<CameraCandidate[]> {
  // Multicast queries sent without a bound interface frequently route through
  // the wrong adapter on Windows. Scanning each IPv4 interface separately and
  // merging results finds cameras regardless of OS routing decisions.
  const targets = interfaceAddress ? [interfaceAddress] : [...new Set(listNetworkInterfaces().map((item) => item.address))];
  const scans = await Promise.allSettled(targets.map((address) => scanOnce(timeoutMs, address)));

  const merged = new Map<string, CameraCandidate>();
  for (const scan of scans) {
    if (scan.status !== 'fulfilled') continue;
    for (const candidate of scan.value) {
      const existing = merged.get(candidate.id);
      merged.set(candidate.id, existing ? { ...existing, ...candidate } : candidate);
    }
  }
  return probeCandidates([...merged.values()]);
}

async function scanOnce(timeoutMs: number, interfaceAddress?: string): Promise<CameraCandidate[]> {
  return new Promise((resolve) => {
    let bonjour: Bonjour;
    let browser: ReturnType<Bonjour['find']>;
    try {
      // bonjour-service forwards unknown options to multicast-dns, including `interface`.
      bonjour = new Bonjour((interfaceAddress ? { interface: interfaceAddress } : {}) as any);
      browser = bonjour.find({ type: SERVICE_TYPE, protocol: 'tcp' });
    } catch {
      resolve([]);
      return;
    }

    const candidates = new Map<string, CameraCandidate>();
    const finish = () => {
      clearTimeout(timer);
      try { browser.stop(); } catch { /* Already stopped. */ }
      try { bonjour.destroy(); } catch { /* Already destroyed. */ }
      resolve([...candidates.values()]);
    };

    browser.on('up', (service: Service) => {
      const addresses = service.addresses?.length ? service.addresses : [service.host];
      for (const address of addresses) {
        if (!address || address.includes('%')) continue;
        // Only IPv4 candidates. IPv6 link-local addresses (fe80::) require a
        // zone id to be routable and can never be probed, so listing them
        // would only produce confusing dead entries.
        if (address.includes(':')) continue;
        const id = `${service.name}|${address}|80`;
        candidates.set(id, {
          id,
          name: service.name,
          host: service.host,
          address,
          port: 80,
          serviceType: SERVICE_LABEL,
          servicePort: service.port,
          txt: normalizeTxt(service.txt),
          reachable: false
        });
      }
    });

    const timer = setTimeout(finish, timeoutMs);
  });
}

async function probeCandidates(candidates: CameraCandidate[]): Promise<CameraCandidate[]> {
  return Promise.all(candidates.map(async (candidate) => {
    // Trust the candidate up front so an HTTPS-only camera (self-signed
    // certificate) can answer the probe before it was ever connected.
    trustCameraHost(candidate.address);
    try {
      const info = await new CameraClient(candidate.address).getInfo(5_000);
      return { ...candidate, reachable: true, info, probeError: undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 401/403 means the HTTP server answered — the camera is present, it
      // just requires credentials. Treat it as reachable so Connect proceeds
      // (the transport retries with credentials at connect time).
      const status = Number(/^(401|403)\b/.exec(message)?.[1] ?? 0);
      return status
        ? { ...candidate, reachable: true, probeError: `Requires authentication (HTTP ${status})` }
        : { ...candidate, reachable: false, probeError: message };
    }
  }));
}

function normalizeTxt(txt: Service['txt']): Record<string, string> {
  return Object.fromEntries(Object.entries(txt ?? {}).map(([key, value]) => [key, String(value)]));
}
