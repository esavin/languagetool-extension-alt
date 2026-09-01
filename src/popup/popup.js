/* LanguageTool Checker — popup */

const $ = (id) => document.getElementById(id);

let settings = null;

/* Должно соответствовать normalizeServerUrl/serverInsecure в background.js. */
function normalizeServerUrl(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) {
    const hostname = u.split('/')[0].split(':')[0].toLowerCase();
    const local = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1';
    u = (local ? 'http://' : 'https://') + u;
  }
  return u;
}

function serverInsecure(url) {
  const u = normalizeServerUrl(url);
  if (!u) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:'
      && !(parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost')
        || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]');
  } catch {
    return false;
  }
}

function updateSecurityWarning() {
  const url = normalizeServerUrl(settings.serverUrl);
  const warn = $('security-warning');
  warn.hidden = !serverInsecure(url);
  if (warn.hidden) return;
  warn.textContent = settings.insecureServerOk === url
    ? 'Сервер задан по HTTP без шифрования: проверяемый текст уходит на него открытым текстом. Используйте https:// в настройках.'
    : 'Проверка заблокирована: сервер задан по HTTP без шифрования. Подтвердите передачу открытым текстом в настройках расширения.';
}

async function init() {
  settings = await chrome.runtime.sendMessage({ type: 'getSettings' });
  if (!settings || settings.error) settings = {};

  $('server-url').textContent = settings.serverUrl || '(сервер не настроен)';
  updateSecurityWarning();

  // статус сервера
  const status = $('status');
  chrome.runtime.sendMessage({ type: 'ping' }).then((res) => {
    if (res && res.ok) {
      status.className = 'status ok';
      status.textContent = 'Сервер доступен (LanguageTool ' + (res.version || '?') + ')';
    } else {
      status.className = 'status err';
      status.textContent = res && res.error === 'NO_SERVER_ACCESS'
        ? 'Нет доступа к серверу — откройте настройки и нажмите «Проверить соединение»'
        : 'Сервер недоступен — проверьте адрес в настройках';
    }
  });

  await initSiteToggle();

  // языки
  const langSel = $('language');
  chrome.runtime.sendMessage({ type: 'languages' }).then((langs) => {
    const seen = new Set();
    for (const l of (Array.isArray(langs) ? langs : [])) {
      if (seen.has(l.longCode)) continue;
      seen.add(l.longCode);
      const opt = document.createElement('option');
      opt.value = l.longCode;
      opt.textContent = l.name + ' (' + l.longCode + ')';
      langSel.appendChild(opt);
    }
    langSel.value = settings.language || 'auto';
    if (langSel.selectedIndex === -1) langSel.value = 'auto';
  });
  langSel.addEventListener('change', async () => {
    settings = await chrome.runtime.sendMessage({
      type: 'saveSettings',
      patch: { language: langSel.value },
    });
  });

  // picky
  $('picky').checked = !!settings.pickyMode;
  $('picky').addEventListener('change', async () => {
    settings = await chrome.runtime.sendMessage({
      type: 'saveSettings',
      patch: { pickyMode: $('picky').checked },
    });
  });

  $('open-options').addEventListener('click', (ev) => {
    ev.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

/* ------------------------------------------------------------------ */
/* Доступ к сайту выдаётся только по явному подтверждению пользователя */
/* (M1): тумблер запрашивает у Chrome host-permission на origin        */
/* текущего сайта и сразу внедряет контент-скрипт в открытую вкладку   */
/* (благодаря activeTab — без перезагрузки страницы).                  */
/* ------------------------------------------------------------------ */

async function getTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function tabSite(tab) {
  if (!tab || !tab.url) return {};
  try {
    const u = new URL(tab.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return {};
    return { host: u.hostname, pattern: u.origin + '/*' };
  } catch {
    return {};
  }
}

async function injectIntoTab(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['src/content.js'] });
    await chrome.scripting.insertCSS({ target: { tabId, allFrames: true }, files: ['src/content.css'] });
  } catch { /* вкладка не допускает внедрения — скрипт появится после перезагрузки */ }
}

async function initSiteToggle() {
  const tab = await getTab();
  const { host, pattern } = tabSite(tab);
  const toggle = $('site-enabled');
  toggle.disabled = !pattern;
  if (!pattern) return;

  const granted = await chrome.permissions.contains({ origins: [pattern] }).catch(() => false);
  toggle.checked = granted && !(settings.disabledSites || []).includes(host);
  $('revoke-site').hidden = !granted;

  toggle.addEventListener('change', async () => {
    if (!toggle.checked) {
      // мягкое отключение: право доступа сохраняем, чтобы не дёргать prompt Chrome
      const list = new Set(settings.disabledSites || []);
      list.add(host);
      settings = await chrome.runtime.sendMessage({
        type: 'saveSettings',
        patch: { disabledSites: [...list] },
      });
      return;
    }
    const grantedNow = await chrome.permissions.request({ origins: [pattern] }).catch(() => false);
    if (!grantedNow) {
      toggle.checked = false;
      return;
    }
    $('revoke-site').hidden = false;
    if (tab.id !== undefined) await injectIntoTab(tab.id);
    const list = new Set(settings.disabledSites || []);
    list.delete(host);
    settings = await chrome.runtime.sendMessage({
      type: 'saveSettings',
      patch: { disabledSites: [...list] },
    });
  });

  $('revoke-site').addEventListener('click', async (ev) => {
    ev.preventDefault();
    const cur = await getTab();
    const site = tabSite(cur);
    if (!site.pattern) return;
    await chrome.permissions.remove({ origins: [site.pattern] }).catch(() => {});
    // чистим и уже внедрённую страницу
    if (site.host) {
      const list = new Set(settings.disabledSites || []);
      list.add(site.host);
      settings = await chrome.runtime.sendMessage({
        type: 'saveSettings',
        patch: { disabledSites: [...list] },
      });
    }
    $('revoke-site').hidden = true;
    toggle.checked = false;
  });
}

document.addEventListener('DOMContentLoaded', init);
