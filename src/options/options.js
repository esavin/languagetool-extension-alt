/* VD LanguageTool Checker — страница настроек */

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

function updateServerWarning() {
  const url = normalizeServerUrl($('server-url').value);
  const insecure = serverInsecure(url);
  $('server-warning').hidden = !insecure;
  $('accept-insecure').hidden = !(insecure && settings && settings.insecureServerOk !== url);
}

/* Fetch к серверу идёт из background-воркера и требует host-permission
 * на origin сервера (M1) — запрашиваем его по жесту пользователя. */
async function ensureServerPermission(url) {
  let pattern = '';
  try { pattern = new URL(url).origin + '/*'; } catch { return false; }
  if (await chrome.permissions.contains({ origins: [pattern] }).catch(() => false)) return true;
  return !!(await chrome.permissions.request({ origins: [pattern] }).catch(() => false));
}

function normalizeLines(text) {
  return text.split('\n').map((s) => s.trim()).filter(Boolean);
}

function toLines(arr) {
  return (arr || []).join('\n');
}

async function load() {
  settings = await chrome.runtime.sendMessage({ type: 'getSettings' });
  if (!settings || settings.error) settings = {};

  $('server-url').value = settings.serverUrl || 'http://localhost:8081';
  updateServerWarning();
  $('preferred-variants').value = settings.preferredVariants || '';
  $('disabled-rules').value = settings.disabledRules || '';
  $('ignored-words').value = toLines(settings.ignoredWords);
  $('disabled-sites').value = toLines(settings.disabledSites);
  $('username').value = settings.username || '';
  $('api-key').value = settings.apiKey || '';
  $('picky').checked = !!settings.pickyMode;

  const langs = await chrome.runtime.sendMessage({ type: 'languages' });
  const list = Array.isArray(langs) ? langs : [];
  for (const selId of ['language', 'mother-tongue']) {
    const sel = $(selId);
    const seen = new Set();
    for (const l of list) {
      if (seen.has(l.longCode)) continue;
      seen.add(l.longCode);
      const opt = document.createElement('option');
      opt.value = l.longCode;
      opt.textContent = l.name + ' (' + l.longCode + ')';
      sel.appendChild(opt);
    }
  }
  $('language').value = settings.language || 'auto';
  if ($('language').selectedIndex === -1) $('language').value = 'auto';
  $('mother-tongue').value = settings.motherTongue || '';
  if ($('mother-tongue').selectedIndex === -1) $('mother-tongue').value = '';
}

async function save() {
  const serverUrl = normalizeServerUrl($('server-url').value.trim()) || 'http://localhost:8081';
  const hasAccess = await ensureServerPermission(serverUrl);
  const patch = {
    serverUrl,
    language: $('language').value,
    motherTongue: $('mother-tongue').value,
    preferredVariants: $('preferred-variants').value.trim(),
    pickyMode: $('picky').checked,
    disabledRules: $('disabled-rules').value.trim(),
    ignoredWords: normalizeLines($('ignored-words').value),
    disabledSites: normalizeLines($('disabled-sites').value),
    username: $('username').value.trim(),
    apiKey: $('api-key').value.trim(),
  };
  settings = await chrome.runtime.sendMessage({ type: 'saveSettings', patch });
  const res = $('save-result');
  res.textContent = hasAccess
    ? 'Сохранено'
    : 'Сохранено, но доступ Chrome к серверу не выдан — нажмите «Проверить соединение»';
  res.className = hasAccess ? 'ok' : 'err';
  setTimeout(() => { res.textContent = ''; }, 4000);
  updateServerWarning();
}

async function testConnection() {
  const res = $('test-result');
  res.textContent = 'Проверка…';
  res.className = '';
  const serverUrl = normalizeServerUrl($('server-url').value.trim()) || 'http://localhost:8081';
  // доступ к origin сервера нужно выдать до запроса (M1)
  const hasAccess = await ensureServerPermission(serverUrl);
  // сначала сохраняем адрес, чтобы ping шёл на введённый сервер
  settings = await chrome.runtime.sendMessage({
    type: 'saveSettings',
    patch: { serverUrl },
  });
  updateServerWarning();
  if (!hasAccess) {
    res.textContent = 'Chrome не выдал доступ к этому адресу сервера';
    res.className = 'err';
    return;
  }
  const ping = await chrome.runtime.sendMessage({ type: 'ping' });
  if (ping && ping.ok) {
    res.textContent = 'OK: LanguageTool ' + (ping.version || '?')
      + (ping.maxTextLength ? ', макс. длина текста ' + ping.maxTextLength : '');
    res.className = 'ok';
    // обновим списки языков с рабочего сервера
    await fillLanguages();
  } else {
    res.textContent = 'Не удалось подключиться (' + (ping && ping.error || 'ошибка') + ')';
    res.className = 'err';
  }
}

async function fillLanguages() {
  const langs = await chrome.runtime.sendMessage({ type: 'languages' });
  const list = Array.isArray(langs) ? langs : [];
  if (!list.length) return;
  for (const selId of ['language', 'mother-tongue']) {
    const sel = $(selId);
    const current = sel.value;
    sel.innerHTML = selId === 'language'
      ? '<option value="auto">Определять автоматически</option>'
      : '<option value="">— не задан —</option>';
    const seen = new Set();
    for (const l of list) {
      if (seen.has(l.longCode)) continue;
      seen.add(l.longCode);
      const opt = document.createElement('option');
      opt.value = l.longCode;
      opt.textContent = l.name + ' (' + l.longCode + ')';
      sel.appendChild(opt);
    }
    sel.value = current;
    if (sel.selectedIndex === -1) sel.value = selId === 'language' ? 'auto' : '';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  $('save').addEventListener('click', save);
  $('test').addEventListener('click', testConnection);
  $('server-url').addEventListener('input', updateServerWarning);
  $('accept-insecure').addEventListener('click', async () => {
    // M2: явное подтверждение передачи открытым текстом, привязанное
    // к конкретному (нормализованному) адресу сервера
    const url = normalizeServerUrl($('server-url').value.trim());
    if (!url || !serverInsecure(url)) return;
    settings = await chrome.runtime.sendMessage({
      type: 'saveSettings',
      patch: { insecureServerOk: url },
    });
    updateServerWarning();
  });
});
