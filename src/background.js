/* VD LanguageTool Checker — background service worker.
 * Единственная точка сетевого взаимодействия: все запросы к серверу
 * LanguageTool уходят отсюда (host-permission на origin сервера,
 * выданный пользователем в настройках, снимает CORS).
 * Никакой телеметрии и обращения к внешним сервисам нет. */

const EXT_USER_AGENT = 'vd-languagetool-chrome/1.0.0';

const DEFAULT_SETTINGS = {
  serverUrl: 'http://localhost:8081',
  language: 'auto',
  motherTongue: '',
  preferredVariants: '',
  pickyMode: false,
  disabledRules: '',
  ignoredWords: [],
  disabledSites: [],
  username: '',
  apiKey: '',
  maxTextLength: 0,
  insecureServerOk: '',
};

/* Учётные данные серверного словаря хранятся отдельным ключом storage
 * (`credentials`), чтобы они не попадали в объект настроек, который
 * расходится по сообщениям и в storage.onChanged контент-скриптов. */
const CRED_KEYS = ['username', 'apiKey'];

async function getSettings() {
  const stored = await chrome.storage.local.get(['settings', 'credentials']);
  return {
    ...DEFAULT_SETTINGS,
    ...(stored.settings || {}),
    ...(stored.credentials || {}),
  };
}

async function saveSettings(patch) {
  const p = patch || {};
  const settings = await getSettings();
  const creds = { username: settings.username || '', apiKey: settings.apiKey || '' };
  for (const [k, v] of Object.entries(p)) {
    if (CRED_KEYS.includes(k)) creds[k] = v;
    else settings[k] = v;
  }
  const stored = { ...settings };
  for (const k of CRED_KEYS) delete stored[k];
  await chrome.storage.local.set({ settings: stored, credentials: creds });
  return settings;
}

/* Контент-скриптам секреты не нужны: отдаём их только страницам
 * расширения (options/popup). Сообщения из контента имеют sender.tab. */
function stripCredentials(settings) {
  const out = { ...settings };
  for (const k of CRED_KEYS) delete out[k];
  return out;
}

function forSender(sender, settings) {
  return sender && sender.tab ? stripCredentials(settings) : settings;
}

function isLocalHostname(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]';
}

function localBareHost(u) {
  const hostname = String(u).split('/')[0].split(':')[0].toLowerCase();
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1';
}

function normalizeServerUrl(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) {
    // Адрес без схемы: локальным оставляем http, остальным — https,
    // чтобы удалённый сервер случайно не настроили открытым текстом.
    u = (localBareHost(u) ? 'http://' : 'https://') + u;
  }
  return u;
}

/* true, если текст будет уходить на сервер без шифрования:
 * http:// и при этом не localhost. */
function serverInsecure(url) {
  const u = normalizeServerUrl(url);
  if (!u) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' && !isLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function apiUrl(settings, path) {
  return normalizeServerUrl(settings.serverUrl) + path;
}

/* ------------------------------------------------------------------ */
/* Контент-скрипт регистрируется динамически на все http/https, но     */
/* реально внедряется только в origin'ы, доступ к которым пользователь  */
/* выдал явно (popup -> chrome.permissions.request). Без постоянных    */
/* host_permissions расширение не читает ничего ни на одном сайте.     */
/* ------------------------------------------------------------------ */

const CONTENT_SCRIPT_ID = 'vdlt-main';

async function ensureContentScripts() {
  try {
    const registered = await chrome.scripting.getRegisteredContentScripts();
    if (registered.some((s) => s.id === CONTENT_SCRIPT_ID)) return;
    await chrome.scripting.registerContentScripts([{
      id: CONTENT_SCRIPT_ID,
      js: ['src/content.js'],
      css: ['src/content.css'],
      matches: ['http://*/*', 'https://*/*'],
      runAt: 'document_idle',
      allFrames: true,
      matchOriginAsFallback: ['about:blank', 'about:srcdoc'],
      persistAcrossSessions: true,
    }]);
  } catch { /* уже зарегистрирован или API недоступен */ }
}

ensureContentScripts();

/* Fetch из background-воркера требует host-permission на origin сервера;
 * он выдаётся пользователем в настройках («Проверить соединение»). */
async function serverAccessOk(server) {
  try {
    const pattern = new URL(server).origin + '/*';
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

/* Удалённый http://-сервер: текст уходил бы открытым текстом, поэтому
 * проверка запрещена, пока пользователь не подтвердил именно этот адрес
 * (кнопка в настройках записывает его в insecureServerOk). */
function insecureConfirmed(settings, server) {
  return settings.insecureServerOk === server;
}

async function doCheck({ text, params }) {
  const settings = await getSettings();
  const server = normalizeServerUrl(settings.serverUrl);
  if (!server) {
    return { error: 'SERVER_NOT_CONFIGURED' };
  }
  if (serverInsecure(server) && !insecureConfirmed(settings, server)) {
    return { error: 'INSECURE_SERVER' };
  }
  if (!(await serverAccessOk(server))) {
    return { error: 'NO_SERVER_ACCESS' };
  }
  const form = new URLSearchParams();
  form.set('text', text);
  form.set('language', params.language || settings.language || 'auto');
  if (settings.motherTongue) form.set('motherTongue', settings.motherTongue);
  if (params.language === 'auto' || !params.language) {
    if (settings.preferredVariants) {
      form.set('preferredVariants', settings.preferredVariants);
    }
  }
  if (settings.pickyMode) form.set('level', 'picky');
  const disabledRules = [settings.disabledRules, params.disabledRules]
    .filter(Boolean).join(',');
  if (disabledRules) form.set('disabledRules', disabledRules);
  form.set('allowIncompleteResults', 'true');
  form.set('useragent', EXT_USER_AGENT);
  if (params.textSessionId) form.set('textSessionId', String(params.textSessionId));
  try {
    // redirect: 'error' — не следуем за redirect'ами: адрес сервера задан
    // явно, а ответ управляет заменами текста на страницах
    const resp = await fetch(server + '/v2/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: form.toString(),
      redirect: 'error',
    });
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => '');
      return { error: 'HTTP_' + resp.status, detail: bodyText.slice(0, 300) };
    }
    return await resp.json();
  } catch (e) {
    return { error: 'NETWORK', detail: String(e && e.message || e) };
  }
}

async function pingServer() {
  const settings = await getSettings();
  const server = normalizeServerUrl(settings.serverUrl);
  if (!server) return { ok: false, error: 'SERVER_NOT_CONFIGURED' };
  if (!(await serverAccessOk(server))) return { ok: false, error: 'NO_SERVER_ACCESS' };
  try {
    const resp = await fetch(server + '/v2/info', { method: 'GET', redirect: 'error' });
    if (!resp.ok) return { ok: false, error: 'HTTP_' + resp.status };
    const json = await resp.json();
    const maxLenResp = await fetch(server + '/v2/maxtextlength', { redirect: 'error' }).catch(() => null);
    let maxTextLength = 0;
    if (maxLenResp && maxLenResp.ok) {
      maxTextLength = parseInt(await maxLenResp.text(), 10) || 0;
      await saveSettings({ maxTextLength });
    }
    return {
      ok: true,
      version: json && json.software && json.software.version,
      premium: json && json.software && json.software.premium,
      maxTextLength,
    };
  } catch (e) {
    return { ok: false, error: 'NETWORK', detail: String(e && e.message || e) };
  }
}

async function fetchLanguages() {
  const settings = await getSettings();
  const server = normalizeServerUrl(settings.serverUrl);
  if (!server) return [];
  try {
    const resp = await fetch(server + '/v2/languages', { redirect: 'error' });
    if (!resp.ok) return [];
    return await resp.json();
  } catch {
    return [];
  }
}

/* Personal dictionary: если заданы username/apiKey — серверный словарь
 * (POST /v2/words/add), иначе — локальный список игнорируемых слов. */
async function addWord({ word, dict }) {
  const settings = await getSettings();
  word = String(word || '').trim();
  if (!word) return { ok: false };
  if (settings.username && settings.apiKey) {
    const server = normalizeServerUrl(settings.serverUrl);
    if (serverInsecure(server) && !insecureConfirmed(settings, server)) {
      return { ok: false, error: 'INSECURE_SERVER' };
    }
    if (!(await serverAccessOk(server))) {
      return { ok: false, error: 'NO_SERVER_ACCESS' };
    }
    const form = new URLSearchParams();
    form.set('username', settings.username);
    form.set('apiKey', settings.apiKey);
    form.set('word', word);
    if (dict) form.set('dict', dict);
    try {
      const resp = await fetch(server + '/v2/words/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: form.toString(),
        redirect: 'error',
      });
      if (!resp.ok) return { ok: false, error: 'HTTP_' + resp.status };
      return { ok: true, remote: true };
    } catch (e) {
      return { ok: false, error: 'NETWORK' };
    }
  }
  const words = new Set(settings.ignoredWords || []);
  words.add(word);
  await saveSettings({ ignoredWords: [...words] });
  return { ok: true, remote: false };
}

function setBadge(tabId, count) {
  const text = count > 0 ? String(count > 999 ? '999+' : count) : '';
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#d93025' });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'getSettings':
        sendResponse(forSender(sender, await getSettings()));
        break;
      case 'saveSettings':
        sendResponse(forSender(sender, await saveSettings(msg.patch || {})));
        break;
      case 'check':
        sendResponse(await doCheck(msg));
        break;
      case 'ping':
        sendResponse(await pingServer());
        break;
      case 'languages':
        sendResponse(await fetchLanguages());
        break;
      case 'addWord':
        sendResponse(await addWord(msg));
        break;
      case 'badge': {
        const tabId = sender && sender.tab && sender.tab.id;
        if (tabId !== undefined) setBadge(tabId, msg.count | 0);
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ error: 'UNKNOWN_MESSAGE' });
    }
  })();
  return true; // async sendResponse
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || changeInfo.url) {
    setBadge(tabId, 0);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await ensureContentScripts();
  await getSettings(); // materialize defaults
});
