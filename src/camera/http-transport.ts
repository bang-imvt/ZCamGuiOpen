import { net, session } from 'electron';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { browserLogin } from './browser-login';

export class CameraHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message: string
  ) {
    // Keep a status code in the text — some firmwares send an empty
    // statusText for 401/403, which would otherwise render as blank.
    super(message ? `${status} ${message}` : `HTTP ${status}`);
    this.name = 'CameraHttpError';
  }
}

export type HttpCredentials = {
  username: string;
  password: string;
};

type Scheme = 'http' | 'https';
type Origin = { scheme: Scheme; port: number };

type DigestChallenge = {
  type: 'digest' | 'basic';
  realm?: string;
  nonce?: string;
  opaque?: string;
  qop?: string;
  algorithm?: string;
  stale?: boolean;
};

const HTTPS_PORTS = [443, 80];

// The embedded camera HTTP server is single-threaded and drops requests
// under concurrent load. All traffic to one camera therefore runs through
// a per-address FIFO queue — strictly one request at a time. Different
// cameras (e.g. parallel mDNS probes) are unaffected.
const cameraQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(address: string, task: () => Promise<T>): Promise<T> {
  const previous = cameraQueues.get(address) ?? Promise.resolve();
  const run = previous.then(task, task); // Proceed even if the previous request failed.
  cameraQueues.set(address, run.then(() => undefined, () => undefined));
  return run;
}

function fetchImpl(): typeof fetch {
  // Electron's net.fetch goes through the Chromium network stack, so the
  // session's certificate-verify hook (trusted camera hosts) applies AND
  // the session cookie store is shared (login sessions persist). Node's
  // global fetch (undici) would reject the camera's self-signed TLS
  // certificate and break HTTPS-only cameras.
  return (net?.fetch?.bind(net) ?? fetch) as typeof fetch;
}

function md5(value: string): string {
  return crypto.createHash('md5').update(value).digest('hex');
}

/**
 * Parses the challenge from a 401 response. Z CAM firmware deliberately sends
 * the non-standard "WWW-Authenticate-X" header: "WWW-Authenticate" itself is a
 * forbidden response header for the fetch API (Chromium hides it from JS), and
 * the camera's own login.min.js reads the -X variant for the same reason.
 */
function parseChallenge(headers: { get(name: string): string | null | undefined }): DigestChallenge | undefined {
  const value = headers.get('www-authenticate-x') ?? headers.get('www-authenticate');
  if (!value) return undefined;
  if (/^\s*basic/i.test(value)) return { type: 'basic' };
  if (!/^\s*digest/i.test(value)) return undefined;
  const param = (name: string): string | undefined => {
    const match = new RegExp(`${name}=("([^"]*)"|([^,\\s]+))`, 'i').exec(value);
    return match?.[2] ?? match?.[3];
  };
  const nonce = param('nonce');
  if (!nonce) return undefined;
  return {
    type: 'digest',
    realm: param('realm'),
    nonce,
    opaque: param('opaque'),
    qop: param('qop'),
    algorithm: param('algorithm'),
    stale: /stale\s*=\s*true/i.test(value)
  };
}

/**
 * Browser-style client nonce: the camera's own login.min.js sends an
 * 11-char lowercase alphanumeric cnonce — mirror that instead of hex in case
 * the firmware validates the format.
 */
function randomCnonce(): string {
  const charset = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 11; i += 1) value += charset[crypto.randomInt(charset.length)];
  return value;
}

/**
 * Node-stack GET used by login() only. Unlike Electron's net.fetch it gives
 * us agent control (single keep-alive socket) and access to Set-Cookie.
 */
type NodeResponse = {
  status: number;
  ok: boolean;
  raw: http.IncomingHttpHeaders;
  body: string;
  get(name: string): string | undefined;
};

function nodeLoginRequest(
  url: URL,
  agent: http.Agent | https.Agent,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<NodeResponse> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(
      url,
      { method: 'GET', agent, headers } as https.RequestOptions,
      (response) => {
        const status = response.statusCode ?? 0;
        // Buffer a small body snippet — 401 bodies sometimes carry the
        // rejection reason in plain text.
        let body = '';
        response.on('data', (chunk: Buffer) => {
          if (body.length < 4096) body += chunk.toString('utf8');
        });
        response.on('end', () => resolve({
          status,
          ok: status >= 200 && status < 300,
          raw: response.headers,
          body,
          get: (name: string) => {
            const value = response.headers[name.toLowerCase()];
            return Array.isArray(value) ? value.join(', ') : value;
          }
        }));
        response.on('error', reject);
      }
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    request.on('error', reject);
    request.end();
  });
}

/**
 * Camera firmware can be set to serve HTTP only, HTTPS only, or both
 * (`https_on` setting). Until one origin answers, each request tries HTTP:80,
 * then HTTPS on the advertised ports, and keeps whichever scheme succeeded.
 *
 * Authentication: Z CAM firmware uses HTTP Digest behind the non-standard
 * "WWW-Authenticate-X" challenge header (see parseChallenge). The challenge is
 * cached and every request carries an Authorization header; a fresh 401
 * challenge (nonce expired) triggers a single transparent retry.
 */
export class CameraHttpTransport {
  readonly address: string;

  private scheme: Scheme = 'http';
  private port = 80;
  private resolved = false;
  // Origins that timed out or refused connections during negotiation —
  // skipped by later requests so a dead scheme costs its timeout only once.
  private readonly unreachable = new Set<string>();
  // User override: 'http'/'https' restricts negotiation to that scheme only.
  private readonly forcedScheme: Scheme | undefined;
  private challenge: DigestChallenge | undefined;
  private ncCount = 0;
  private cnonce = randomCnonce();
  private authToken: string | undefined;

  constructor(
    address: string,
    private credentials?: HttpCredentials,
    private readonly defaultTimeoutMs = 20_000,
    forcedScheme?: string
  ) {
    this.address = address;
    this.forcedScheme = forcedScheme === 'http' || forcedScheme === 'https' ? forcedScheme : undefined;
  }

  get secure(): boolean { return this.scheme === 'https'; }

  private progressListener: ((message: string) => void) | undefined;

  /** UI progress for long-running background steps (login, browser fallback). */
  onProgress(listener: (message: string) => void): void {
    this.progressListener = listener;
  }

  private progress(message: string): void {
    this.progressListener?.(message);
  }

  /** True once an origin actually answered — sessions must not be "quit" on cameras we never reached. */
  get negotiated(): boolean { return this.resolved; }

  /**
   * Official web UI behavior: when the camera reports https_on, the whole
   * session (preview, WebRTC signaling included) moves to HTTPS — the http
   * origin only serves GETs reliably on some firmwares. Tries /info over
   * https:443; on success requestOnce locks that origin (redirect-aware).
   */
  async preferHttps(): Promise<boolean> {
    if (this.scheme === 'https') return true;
    return enqueue(this.address, async () => {
      const url = new URL('/info', `https://${formatAddress(this.address)}:443/`);
      try {
        await this.requestOnce(url, 5_000);
        return true;
      } catch {
        return false; // Keep the working origin.
      }
    });
  }

  get baseUrl(): string {
    return `${this.scheme}://${formatAddress(this.address)}:${this.port}`;
  }

  mediaUrl(path: string): string {
    return new URL(path, `${this.baseUrl}/`).toString();
  }

  /**
   * HTTP Digest login against /login/ (the endpoint the camera's own
   * login.min.js uses). Runs over Node http/https with a keep-alive agent:
   * some firmwares bind the Digest nonce to the TCP connection, so the
   * challenge request and the authenticated request MUST share one socket —
   * exactly what the browser does. The session cookie is copied into the
   * Electron cookie store so later net.fetch requests carry it like a browser.
   */
  login(): Promise<void> {
    return enqueue(this.address, async () => {
      if (!this.credentials) throw new Error('Login requires credentials');
      const origins = this.resolved ? [{ scheme: this.scheme, port: this.port }] : candidateOrigins(this.forcedScheme);
      // Per-origin outcome accumulates into the error so a rejected login
      // reports exactly which scheme/port failed and why.
      const attempts: string[] = [];
      let lastError: unknown;
      // A credential REJECTION outranks a later origin's timeout — it is the
      // actionable reason ("password wrong"), not a network artifact.
      let rejected: Error | undefined;
      // First origin that issued a Digest challenge — the browser-login
      // fallback replays the page flow against this exact origin.
      let challengeOrigin: string | undefined;
      const agents = new Map<Scheme, http.Agent | https.Agent>();
      const agentFor = (scheme: Scheme): http.Agent | https.Agent => {
        let agent = agents.get(scheme);
        if (!agent) {
          agent = scheme === 'https'
            ? new https.Agent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: false })
            : new http.Agent({ keepAlive: true, maxSockets: 1 });
          agents.set(scheme, agent);
        }
        return agent;
      };

      try {
        for (const origin of origins) {
          const originLabel = originString(origin, this.address);
          const url = new URL('/login/', originLabel);
          // Browsers strip default ports from the Host header
          // (`Host: ip`, not `Host: ip:443`) — some embedded servers bind the
          // Digest session to an exact Host match and 401 otherwise.
          // Header names are sent Title-Cased like a browser does; embedded
          // HTTP parsers frequently do case-SENSITIVE header matching.
          const defaultPort = origin.scheme === 'https' ? '443' : '80';
          const hostHeader = url.port && url.port !== defaultPort ? url.host : url.hostname;
          // Match the camera's own login page (login.min.js) request shape:
          // some firmwares reject logins lacking the page context headers.
          const browserHeaders: Record<string, string> = {
            Host: hostHeader,
            Accept: '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'max-age=0',
            Referer: `${originLabel}/www/html/login.html`,
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
            'X-Requested-With': 'XMLHttpRequest',
            'sec-ch-ua': '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"'
          };
          try {
            // The browser enters through http:80 and is redirected to https
            // before it ever POSTs credentials — replay that entry hop so any
            // server-side per-client session state gets created the same way.
            if (origin.scheme === 'https' && !this.unreachable.has(`http://${this.address}:80`)) {
              try {
                await nodeLoginRequest(new URL(`http://${this.address}/`), agentFor('http'), { Host: this.address }, Math.min(this.defaultTimeoutMs, 4000));
              } catch {
                // Entry hop is best-effort — camera may be https-only.
              }
            }
            const first = await nodeLoginRequest(url, agentFor(origin.scheme), browserHeaders, Math.min(this.defaultTimeoutMs, 8_000));
            console.log(`[login] challenge at ${originLabel}: HTTP ${first.status}, connection: ${first.get('connection') ?? 'n/a'}, authenticate: ${first.get('www-authenticate-x') ?? first.get('www-authenticate') ?? 'none'}`);
            if (first.ok) {
              this.remember(origin); // Session already valid on this origin.
              this.challenge = undefined;
              return;
            }
            if (first.status !== 401) {
              attempts.push(`${originLabel}: HTTP ${first.status} on challenge request`);
              throw new CameraHttpError(first.status, '/login/', 'challenge request failed');
            }
            const challenge = parseChallenge(first);
            if (!challenge) {
              // A 401 without a challenge (e.g. http:80 quirk) — try the next origin.
              attempts.push(`${originLabel}: 401 without WWW-Authenticate-X challenge`);
              lastError = new Error('401 without a WWW-Authenticate-X challenge');
              continue;
            }
            challengeOrigin = challengeOrigin ?? originLabel;
            this.progress(`Signing in (Digest, ${originLabel})...`);
            this.cnonce = randomCnonce(); // fresh client nonce per attempt, like a browser
            const auth = this.authorizationFor(challenge, 'GET', '/login/');
            if (!auth) throw new Error('Login requires credentials');
            let second = await nodeLoginRequest(url, agentFor(origin.scheme), { ...browserHeaders, authorization: auth }, Math.min(this.defaultTimeoutMs, 8_000));
            // A 401 answered with stale=true means the nonce aged out, not that
            // the credentials are wrong — retry once against the fresh nonce.
            if (second.status === 401) {
              const fresh = parseChallenge(second);
              if (fresh?.stale && fresh.nonce && fresh.nonce !== challenge.nonce) {
                const retryAuth = this.authorizationFor(fresh, 'GET', '/login/');
                if (retryAuth) {
                  second = await nodeLoginRequest(url, agentFor(origin.scheme), { ...browserHeaders, authorization: retryAuth }, Math.min(this.defaultTimeoutMs, 8_000));
                }
              }
            }
            if (!second.ok) {
              // Trace the exact header we sent plus the camera's rejection
              // response (headers + body often carry the actual reason) so it
              // can be compared with a working browser capture (main console).
              // Never log credentials — the Authorization header below is a
              // Digest hash (username + one-way response), not the password.
              console.log(`[login] rejected at ${originLabel}: sent authorization: ${auth}`);
              console.log(`[login] rejection response: HTTP ${second.status}, connection: ${second.get('connection') ?? 'n/a'}, authenticate: ${second.get('www-authenticate-x') ?? second.get('www-authenticate') ?? 'none'}, body: ${JSON.stringify(second.body.slice(0, 300))}`);
              // Credentials were evaluated and rejected on THIS origin. Try the
              // remaining origins (firmware quirks can make one scheme reject
              // what the other accepts); if every origin rejects, the last
              // rejection is reported below.
              attempts.push(`${originLabel}: credentials rejected (HTTP ${second.status}, realm "${challenge.realm ?? '?'}", qop ${challenge.qop ?? 'none'}, algorithm ${challenge.algorithm ?? 'MD5'})`);
              const rejection = new Error(`Login rejected (HTTP ${second.status}) — check username/password`);
              lastError = rejection;
              rejected = rejection;
              continue;
            }
            this.challenge = challenge;
            this.ncCount = 1;
            this.authToken = second.get('x-auth-token') ?? undefined;
            // Node-side login bypasses the Electron cookie jar — copy the
            // session cookie in so subsequent net.fetch requests carry it.
            const cookies = second.raw['set-cookie'];
            if (cookies?.length) {
              for (const line of cookies) {
                const pair = line.split(';')[0] ?? '';
                const eq = pair.indexOf('=');
                if (eq > 0) {
                  await session.defaultSession.cookies.set({
                    url: originLabel,
                    name: pair.slice(0, eq).trim(),
                    value: pair.slice(eq + 1).trim()
                  });
                }
              }
            }
            this.remember(origin);
            return;
          } catch (error) {
            if (error instanceof CameraHttpError) { lastError = error; continue; }
            if (isAbort(error)) {
              // Unresponsive origin — mark it so later attempts skip it.
              this.unreachable.add(originString(origin, this.address));
              attempts.push(`${originLabel}: timeout after ${this.defaultTimeoutMs}ms`);
              lastError = new Error(`Login timeout after ${this.defaultTimeoutMs}ms`);
              continue;
            }
            attempts.push(`${originLabel}: ${error instanceof Error ? error.message : String(error)}`);
            lastError = error;
          }
        }
      } finally {
        for (const agent of agents.values()) agent.destroy();
      }

      // Firmware quirk: some cameras reject a mathematically correct Digest
      // response sent outside their own page flow (body claims "Invalid
      // username or password" even with the right password). Fall back to the
      // camera's own login page in a hidden Chromium window — the page's
      // login.min.js performs the exact browser flow, and the session cookie
      // it sets authenticates all subsequent net.fetch requests.
      if (rejected && this.credentials && challengeOrigin) {
        try {
          this.progress('Digest rejected — opening the camera login page in the background...');
          console.log(`[login] digest rejected — trying browser-equivalent login via hidden window at ${challengeOrigin}`);
          await browserLogin(this.address, this.credentials, challengeOrigin);
          const url = new URL(challengeOrigin);
          this.remember({
            scheme: url.protocol.replace(':', '') as Scheme,
            port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
          });
          this.challenge = undefined;
          this.progress('Signed in via the camera login page.');
          console.log(`[login] browser login succeeded via ${challengeOrigin}`);
          return;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.progress(`Background page login failed: ${reason}`);
          console.log('[login] browser login failed:', reason);
          attempts.push(`background page login failed: ${reason}`);
        }
      }

      const primary = rejected ?? lastError;
      const detail = attempts.length ? ` (${attempts.join('; ')})` : '';
      throw primary instanceof Error ? new Error(`${primary.message}${detail}`) : new Error(String(primary));
    });
  }

  /** Headers for non-fetch channels (WebSocket upgrade on :81). */
  handshakeHeaders(): Record<string, string> | undefined {
    const headers: Record<string, string> = {};
    const auth = this.authorizationFor(this.challenge, 'GET', '/');
    if (auth) headers.authorization = auth;
    if (this.authToken) headers['x-auth-token'] = this.authToken;
    return Object.keys(headers).length ? headers : undefined;
  }

  get<T = unknown>(path: string, timeoutMs = this.defaultTimeoutMs): Promise<T> {
    return enqueue(this.address, () => this.getThroughOrigins<T>(path, timeoutMs, (response) => response.json() as Promise<T>));
  }

  getText(path: string, timeoutMs = this.defaultTimeoutMs): Promise<string> {
    return enqueue(this.address, () => this.getThroughOrigins(path, timeoutMs, (response) => response.text()));
  }

  getBytes(path: string, timeoutMs = this.defaultTimeoutMs): Promise<{ data: Uint8Array; contentType: string }> {
    return enqueue(this.address, () => this.getThroughOrigins(path, timeoutMs, async (response) => ({
      data: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream'
    })));
  }

  private async getThroughOrigins<T = unknown>(path: string, timeoutMs: number, parse: (response: Response) => Promise<T>): Promise<T> {
    const origins = this.resolved
      ? [{ scheme: this.scheme, port: this.port }]
      : candidateOrigins(this.forcedScheme).filter((origin) => !this.unreachable.has(originString(origin, this.address)));
    let lastError: unknown;
    let lastStatusError: CameraHttpError | undefined;

    for (const origin of origins) {
      const url = new URL(path, `${originString(origin, this.address)}/`);
      try {
        // requestOnce remembers the origin a redirect chain actually ended on.
        return await this.requestOnce<T>(url, timeoutMs, parse);
      } catch (error) {
        if (error instanceof CameraHttpError) {
          // During negotiation an HTTP status may describe the *scheme*, not
          // the camera: 401/403 can be scheme-specific auth behavior, and a
          // 5xx (e.g. 503 from an https_on camera's http port) means "wrong
          // scheme — use the other one". Neither locks the origin; only a
          // real success or another status (404 …) on an already-resolved
          // origin does.
          const wrongSchemeHint = !this.resolved
            && (error.status === 401 || error.status === 403 || (error.status >= 500 && error.status <= 599));
          if (!wrongSchemeHint) {
            this.remember(origin);
            throw error;
          }
          lastStatusError = lastStatusError ?? error;
          continue;
        }
        if (isAbort(error)) {
          // Unresponsive origin (e.g. an HTTP port that silently drops
          // packets). Mark it so the remaining queued requests skip it —
          // an HTTPS-only camera behind a quiet :80 must not cost its
          // timeout again on every single request.
          this.unreachable.add(originString(origin, this.address));
          lastError = new Error(`Request timeout after ${timeoutMs}ms: ${url.pathname}`);
          continue;
        }
        // Connection refused / TLS failure: this origin will not recover
        // within this session either — skip it from now on.
        this.unreachable.add(originString(origin, this.address));
        lastError = error; // Fall through to the next origin.
      }
    }

    throw lastStatusError ?? (lastError instanceof Error ? lastError : new Error(String(lastError)));
  }

  private remember(origin: Origin): void {
    this.scheme = origin.scheme;
    this.port = origin.port;
    this.resolved = true;
  }

  private authorizationFor(challenge: DigestChallenge | undefined, method: string, path: string): string | undefined {
    if (!this.credentials || !challenge) {
      return this.credentials ? `Basic ${Buffer.from(`${this.credentials.username}:${this.credentials.password}`).toString('base64')}` : undefined;
    }
    if (challenge.type === 'basic') {
      return `Basic ${Buffer.from(`${this.credentials.username}:${this.credentials.password}`).toString('base64')}`;
    }
    this.ncCount += 1;
    const nc = this.ncCount.toString(16).padStart(8, '0');
    // MD5 (default) and MD5-sess: with MD5-sess the HA1 is bound to the
    // nonce+cnonce pair per RFC 7616 — some firmware endpoints use it while
    // others use plain MD5, so we honor whatever the challenge declares.
    let ha1 = md5(`${this.credentials.username}:${challenge.realm}:${this.credentials.password}`);
    if (challenge.algorithm && /md5-sess/i.test(challenge.algorithm)) {
      ha1 = md5(`${ha1}:${challenge.nonce}:${this.cnonce}`);
    }
    const ha2 = md5(`${method}:${path}`);
    const response = challenge.qop
      ? md5(`${ha1}:${challenge.nonce}:${nc}:${this.cnonce}:${challenge.qop}:${ha2}`)
      : md5(`${ha1}:${challenge.nonce}:${ha2}`);
    const parts = [
      `username="${this.credentials.username}"`,
      `realm="${challenge.realm}"`,
      `nonce="${challenge.nonce}"`,
      `uri="${path}"`,
      `response="${response}"`
    ];
    if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithm}`);
    if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
    if (challenge.qop) parts.push(`qop=${challenge.qop}`, `nc=${nc}`, `cnonce="${this.cnonce}"`);
    return `Digest ${parts.join(', ')}`;
  }

  private async requestOnce<T>(url: URL, timeoutMs: number, parse: (response: Response) => Promise<T> = (response) => response.json() as Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const doFetch = fetchImpl();
    const path = `${url.pathname}${url.search}`;
    const headers: Record<string, string> = {};
    const auth = this.authorizationFor(this.challenge, 'GET', path);
    if (auth) headers.authorization = auth;

    try {
      const response = await doFetch(url, { headers, signal: controller.signal });
      if (response.ok) {
        this.rememberFinal(response.url); // A redirect chain may end on another scheme/port.
        return await parse(response);
      }
      // Nonce expired or session dropped: a fresh 401 challenge updates the
      // cached state and the request is retried once transparently.
      if (response.status === 401 && this.credentials) {
        const fresh = parseChallenge(response.headers);
        if (fresh) {
          this.challenge = fresh;
          this.ncCount = 0;
          const retryAuth = this.authorizationFor(fresh, 'GET', path);
          const retry = await doFetch(url, { headers: { ...headers, authorization: retryAuth ?? '' }, signal: controller.signal });
          if (retry.ok) {
            this.rememberFinal(retry.url);
            return (await retry.json()) as T;
          }
          throw new CameraHttpError(retry.status, url.pathname, retry.statusText);
        }
      }
      throw new CameraHttpError(response.status, url.pathname, response.statusText);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Locks the origin a request actually landed on. Firmware that redirects
   * http:80 → https:443 (HSTS/307) used to leave the transport resolved to
   * http, producing http:// preview URLs for HTTPS cameras — the final URL
   * of the response chain is the truth.
   */
  private rememberFinal(finalUrl: string | undefined): void {
    if (!finalUrl) return;
    try {
      const parsed = new URL(finalUrl);
      const scheme: Scheme = parsed.protocol === 'https:' ? 'https' : 'http';
      const port = parsed.port ? Number(parsed.port) : scheme === 'https' ? 443 : 80;
      this.remember({ scheme, port });
    } catch { /* Keep whatever origin was negotiated before. */ }
  }
}

function candidateOrigins(forcedScheme?: Scheme): Origin[] {
  if (forcedScheme === 'https') return [{ scheme: 'https', port: 443 }, { scheme: 'https', port: 80 }];
  if (forcedScheme === 'http') return [{ scheme: 'http', port: 80 }];
  const origins: Origin[] = [{ scheme: 'http', port: 80 }];
  for (const port of HTTPS_PORTS) origins.push({ scheme: 'https', port });
  return origins;
}

function originString(origin: Origin, address: string): string {
  return `${origin.scheme}://${formatAddress(address)}:${origin.port}`;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function formatAddress(address: string): string {
  return address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;
}
