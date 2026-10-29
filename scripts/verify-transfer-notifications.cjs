#!/usr/bin/env node

/*
 * Real-browser smoke test for transfer notifications.
 *
 * This intentionally uses Chromium's DevTools Protocol instead of a test
 * framework so it can run with the browser binary supplied by Replit.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const { WebSocket } = require('ws');
const { Pool } = require('pg');

const origin = process.env.WALLET_TEST_ORIGIN || 'http://127.0.0.1:3000';
const chromiumPath = process.env.CHROMIUM_PATH || process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/repl/tools/bin/chromium';
const screenshotDir = path.resolve(process.env.WALLET_TEST_SCREENSHOT_DIR || 'artifacts/transfer-notification-evidence');
const testPassword = `BrowserTest-${Date.now()}`;
const testPin = '2468';
const createdTestUsernames = new Set();

const browserInstrumentation = `
  (() => {
    window.__walletBrowserTest = {
      notificationConstructors: [],
      serviceWorkerNotifications: [],
      audioContexts: 0,
      oscillators: 0,
      oscillatorStarts: 0
    };

    const state = window.__walletBrowserTest;
    const NativeNotification = window.Notification;
    if (NativeNotification) {
      window.Notification = new Proxy(NativeNotification, {
        construct(target, args, newTarget) {
          state.notificationConstructors.push({ title: args[0], options: args[1] || {} });
          return Reflect.construct(target, args, newTarget);
        }
      });
    }

    if (window.ServiceWorkerRegistration?.prototype?.showNotification) {
      const nativeShowNotification = window.ServiceWorkerRegistration.prototype.showNotification;
      window.ServiceWorkerRegistration.prototype.showNotification = function (...args) {
        state.serviceWorkerNotifications.push({ title: args[0], options: args[1] || {} });
        return nativeShowNotification.apply(this, args);
      };
    }

    const NativeAudioContext = window.AudioContext || window.webkitAudioContext;
    if (NativeAudioContext) {
      const InstrumentedAudioContext = new Proxy(NativeAudioContext, {
        construct(target, args, newTarget) {
          const context = Reflect.construct(target, args, newTarget);
          state.audioContexts += 1;
          const nativeCreateOscillator = context.createOscillator.bind(context);
          context.createOscillator = (...oscillatorArgs) => {
            const oscillator = nativeCreateOscillator(...oscillatorArgs);
            state.oscillators += 1;
            const nativeStart = oscillator.start.bind(oscillator);
            oscillator.start = (...startArgs) => {
              state.oscillatorStarts += 1;
              return nativeStart(...startArgs);
            };
            return oscillator;
          };
          return context;
        }
      });
      window.AudioContext = InstrumentedAudioContext;
      if (window.webkitAudioContext) window.webkitAudioContext = InstrumentedAudioContext;
    }
  })();
`;

class DevToolsConnection {
  constructor(socketUrl) {
    this.socket = new WebSocket(socketUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result || {});
        return;
      }

      const listeners = this.events.get(message.method) || [];
      for (const listener of listeners) listener(message.params || {});
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
    });
  }

  close() {
    this.socket.close();
  }
}

class BrowserPage {
  constructor(connection, sessionId, targetId) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  send(method, params = {}) {
    return this.connection.send(method, params, this.sessionId);
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Browser evaluation failed');
    }
    return result.result?.value;
  }

  async waitFor(description, expression, timeoutMs = 15000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await this.evaluate(expression)) return;
      await sleep(200);
    }
    throw new Error(`Timed out waiting for ${description}`);
  }

  async clickText(text, selector = 'button') {
    const clicked = await this.evaluate(`(() => {
      const item = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((element) => element.textContent.includes(${JSON.stringify(text)}));
      if (!item) return false;
      item.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`Could not find ${text}`);
  }

  async setInput(selector, value) {
    const updated = await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return false;
      const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      setter?.call(element, ${JSON.stringify(String(value))});
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!updated) throw new Error(`Could not fill ${selector}`);
  }

  async setInputAt(selector, index, value) {
    const updated = await this.evaluate(`(() => {
      const element = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      if (!element) return false;
      const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      setter?.call(element, ${JSON.stringify(String(value))});
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!updated) throw new Error(`Could not fill ${selector}[${index}]`);
  }

  async screenshot(filename) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    await fs.mkdir(screenshotDir, { recursive: true });
    await fs.writeFile(path.join(screenshotDir, filename), Buffer.from(result.data, 'base64'));
  }

  async close() {
    await this.connection.send('Target.closeTarget', { targetId: this.targetId });
  }
}

async function launchBrowser() {
  const userDataDir = `/tmp/wallet-notification-browser-${process.pid}`;
  const processHandle = spawn(chromiumPath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  processHandle.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const startedAt = Date.now();
  let debuggingPort;
  while (!debuggingPort && Date.now() - startedAt < 10000) {
    const match = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (match) debuggingPort = match[1];
    else await sleep(100);
  }
  if (!debuggingPort) {
    processHandle.kill('SIGTERM');
    throw new Error(`Chromium did not expose DevTools: ${stderr}`);
  }

  const version = await fetch(`http://127.0.0.1:${debuggingPort}/json/version`).then((response) => response.json());
  const connection = new DevToolsConnection(version.webSocketDebuggerUrl);
  await connection.connect();
  return { connection, processHandle };
}

async function createPage(browser) {
  const { browserContextId } = await browser.connection.send('Target.createBrowserContext', { disposeOnDetach: true });
  await browser.connection.send('Browser.grantPermissions', {
    origin,
    permissions: ['notifications'],
    browserContextId,
  });
  const { targetId } = await browser.connection.send('Target.createTarget', {
    url: 'about:blank',
    browserContextId,
  });
  const { sessionId } = await browser.connection.send('Target.attachToTarget', { targetId, flatten: true });
  const page = new BrowserPage(browser.connection, sessionId, targetId);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: browserInstrumentation });
  await page.send('Page.navigate', { url: origin });
  await page.waitFor('login screen', `document.querySelector('#loginScreen') !== null`);
  return page;
}

async function createAccount(suffix) {
  const username = `browser-check-${Date.now()}-${suffix}`;
  createdTestUsernames.add(username);
  const response = await fetch(`${origin}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `اختبار المتصفح ${suffix}`, username, password: testPassword, pin: testPin }),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error || 'Could not create browser test account');
  return { username, password: testPassword };
}

async function cleanupTestAccounts() {
  const usernames = [...createdTestUsernames];
  if (usernames.length === 0) return;

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const accountResult = await client.query(
      `SELECT a.id
       FROM accounts a
       JOIN users u ON u.id = a.user_id
       WHERE u.username LIKE 'browser-check-%'
          OR u.username = ANY($1::text[])`,
      [usernames],
    );
    const accountIds = accountResult.rows.map((row) => row.id);

    if (accountIds.length > 0) {
      await client.query(
        `DELETE FROM money_requests
         WHERE requester_account_id = ANY($1::int[])
            OR target_account_id = ANY($1::int[])`,
        [accountIds],
      );
      await client.query(
        `DELETE FROM transactions
         WHERE sender_account_id = ANY($1::int[])
            OR receiver_account_id = ANY($1::int[])`,
        [accountIds],
      );
      await client.query(
        'DELETE FROM vouchers WHERE used_by_account_id = ANY($1::int[])',
        [accountIds],
      );
    }

    await client.query(
      `DELETE FROM users
       WHERE username LIKE 'browser-check-%'
          OR username = ANY($1::text[])`,
      [usernames],
    );
    await client.query('COMMIT');
    console.log(`Cleaned ${usernames.length} browser test accounts`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function login(page, account) {
  await page.setInput('#loginInput', account.username);
  await page.setInput('#password', account.password);
  await page.clickText('دخول', 'form#loginForm button[type="submit"]');
  await page.waitFor('authenticated app', `document.querySelector('#appScreen') && !document.querySelector('#appScreen').classList.contains('hidden')`);
  return page.evaluate(`fetch('/api/me', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } }).then((response) => response.json())`);
}

async function run() {
  let browser;
  let senderPage;
  let receiverPage;
  try {
    const accountSender = await createAccount('sender');
    const accountReceiver = await createAccount('receiver');
    browser = await launchBrowser();
    senderPage = await createPage(browser);
    receiverPage = await createPage(browser);
    const [senderData, receiverData] = await Promise.all([
      login(senderPage, accountSender),
      login(receiverPage, accountReceiver),
    ]);
    const receiverAccountId = receiverData.account.id;

    await receiverPage.waitFor('granted notification label', `document.body.innerText.includes('الإشعارات مفعّلة')`);
    const permission = await receiverPage.evaluate(`Notification.permission`);
    await receiverPage.screenshot('recipient-before-transfer.png');

    await senderPage.evaluate(`window.switchTab('transfer')`);
    await senderPage.waitFor('subscriber transfer action', `document.body.innerText.includes('تحويل إلى مشترك')`);
    await senderPage.clickText('تحويل إلى مشترك');
    await senderPage.waitFor('subscriber transfer form', `document.querySelector('#transfersReactRoot input[placeholder="700000002"]') !== null`);

    const amountInputs = await senderPage.evaluate(`[...document.querySelectorAll('#transfersReactRoot input[type="number"]')].length`);
    if (amountInputs < 1) throw new Error('Subscriber transfer form did not expose the amount input');
    await senderPage.setInput('#transfersReactRoot input[placeholder="700000002"]', receiverAccountId);
    await senderPage.setInputAt('#transfersReactRoot input[type="number"]', 0, '1');
    await senderPage.setInput('#transfersReactRoot select', 'YER');
    await senderPage.setInput('#transfersReactRoot input[type="password"]', testPin);
    await senderPage.clickText('التحقق من المستلم', '#transfersReactRoot button');
    await senderPage.waitFor('receiver lookup result', `document.body.innerText.includes('تم العثور على حساب المستلم')`);
    await senderPage.clickText('تأكيد الحوالة', '#transfersReactRoot button');
    await senderPage.waitFor('sender transfer receipt', `document.body.innerText.includes('سند حوالة مالية')`, 20000);
    await senderPage.screenshot('sender-after-transfer.png');

    await receiverPage.waitFor('recipient transfer toast', `document.body.innerText.includes('حوالة جديدة') && document.body.innerText.includes('1 YER')`, 20000);
    await receiverPage.screenshot('recipient-after-transfer.png');
    const evidence = await receiverPage.evaluate(`({
      permission: Notification.permission,
      toast: document.body.innerText.includes('حوالة جديدة') && document.body.innerText.includes('1 YER'),
      notificationConstructors: window.__walletBrowserTest.notificationConstructors,
      serviceWorkerNotifications: window.__walletBrowserTest.serviceWorkerNotifications,
      audioContexts: window.__walletBrowserTest.audioContexts,
      oscillators: window.__walletBrowserTest.oscillators,
      oscillatorStarts: window.__walletBrowserTest.oscillatorStarts,
      connectionStatus: [...document.querySelectorAll('[role="status"]')].map((element) => element.innerText)
    })`);

    if (!evidence.toast) throw new Error('Recipient Toast did not include the transfer');
    if (evidence.permission !== 'granted') throw new Error(`Notification permission was ${evidence.permission}`);
    if (evidence.audioContexts < 1 || evidence.oscillatorStarts < 1) throw new Error('No WebAudio oscillator was started');
    if (evidence.notificationConstructors.length < 1 && evidence.serviceWorkerNotifications.length < 1) {
      throw new Error('No browser/system notification call was observed');
    }

    console.log(JSON.stringify({
      ok: true,
      origin,
      accounts: { senderAccountId: senderData.account.id, receiverAccountId },
      permission,
      toast: evidence.toast,
      audio: { contexts: evidence.audioContexts, oscillators: evidence.oscillators, starts: evidence.oscillatorStarts },
      systemNotification: {
        direct: evidence.notificationConstructors.length,
        serviceWorker: evidence.serviceWorkerNotifications.length,
      },
      connectionStatus: evidence.connectionStatus,
      screenshots: [
        path.join(screenshotDir, 'recipient-before-transfer.png'),
        path.join(screenshotDir, 'sender-after-transfer.png'),
        path.join(screenshotDir, 'recipient-after-transfer.png'),
      ],
      note: 'Chromium headless verifies the notification API call and permission; audible playback and the OS notification surface still require a headed/manual run.',
    }, null, 2));
  } finally {
    await senderPage?.close().catch(() => {});
    await receiverPage?.close().catch(() => {});
    browser?.connection.close();
    browser?.processHandle.kill('SIGTERM');
    await cleanupTestAccounts();
  }
}

run().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
});