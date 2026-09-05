import { BrowserWindow, session } from 'electron';

/**
 * Browser-equivalent login fallback. Some firmwares reject a mathematically
 * correct Digest response sent outside their own page flow (the response body
 * still claims "Invalid username or password"). The guaranteed-equivalent
 * path is to let the camera's own login.min.js do the login inside a hidden
 * Chromium window: same page, same JS, same session. The session cookie lands
 * in the shared Electron cookie store, after which normal net.fetch requests
 * are authenticated.
 */

// Builds the in-page fill+submit script with the credentials inlined
// (executeJavaScript cannot pass arguments; JSON.stringify escapes safely).
function fillScript(username: string, password: string): string {
  return `(async () => {
    const user = document.querySelector('input[type="text"], input:not([type="password"])');
    const pass = document.querySelector('input[type="password"]');
    if (!user || !pass) return 'not-found';
    const setValue = (input, value) => {
      input.focus();
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setValue(user, ${JSON.stringify(username)});
    setValue(pass, ${JSON.stringify(password)});
    const button = document.querySelector('[class*="login"] button, button[class*="login"], #loginBtn, .login-btn, button[type="submit"], input[type="submit"], form button');
    if (button) { button.click(); return 'clicked'; }
    const form = document.querySelector('form');
    if (form) { form.requestSubmit(); return 'submitted'; }
    return 'filled';
  })()`;
}

export async function browserLogin(address: string, credentials: { username: string; password: string }, base: string): Promise<void> {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  try {
    console.log(`[browser-login] loading ${base}/www/html/login.html`);
    await window.loadURL(`${base}/www/html/login.html`);
    console.log(`[browser-login] page loaded: ${window.webContents.getURL()}`);
    // The form may live in the main frame or inside an iframe — try each.
    const script = fillScript(credentials.username, credentials.password);
    let result = await window.webContents.executeJavaScript(script).catch(() => 'not-found');
    if (result === 'not-found') {
      for (const frame of window.webContents.mainFrame.frames) {
        result = await frame.executeJavaScript(script).catch(() => 'not-found');
        if (result !== 'not-found') break;
      }
    }
    console.log(`[browser-login] form fill result: ${result}`);
    if (result === 'not-found') throw new Error('login form not found on page or frames');
    // The page's own JS performs the Digest XHR and the camera sets the
    // session cookie on success — poll the shared cookie store for it.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const cookies = await session.defaultSession.cookies.get({ url: base });
      if (cookies.some((cookie) => cookie.name === 'account')) {
        console.log('[browser-login] account cookie received — signed in');
        return;
      }
    }
    const all = await session.defaultSession.cookies.get({});
    console.log(`[browser-login] no account cookie; cookies now: ${JSON.stringify(all.map((c) => `${c.domain}${c.path} :: ${c.name}`))}`);
    throw new Error('no account cookie after page login');
  } finally {
    window.destroy();
  }
}
