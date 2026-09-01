/* VD LanguageTool Checker — content script.
 *
 * Логика:
 *  1. Находим редактируемые элементы (textarea, input, contenteditable).
 *  2. По паузе в наборе текста отправляем текст через background на сервер
 *     LanguageTool (POST /v2/check) и получаем список ошибок с offset/length.
 *  3. Рисуем подчёркивания в overlay-слое, НЕ меняя DOM редактируемого
 *     элемента (безопасно для Confluence/Gmail/React-редакторов).
 *  4. Клик по подчёркиванию — карточка с вариантами замены; исправление
 *     применяется через setRangeText (textarea) или execCommand/Range
 *     (contenteditable) с сохранением undo-стека редактора.
 */

(() => {
  'use strict';

  if (window.__vdltInjected) return;
  window.__vdltInjected = true;

  const DEBOUNCE_MS = 600;
  const MIN_TEXT_LEN = 3;
  const MAX_RENDERED = 300;

  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DETAILS', 'DIV', 'DL', 'DT', 'DD',
    'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
    'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'THEAD', 'TBODY',
    'TR', 'TD', 'TH', 'UL', 'FORM', 'FIELDSET',
  ]);

  const ALLOWED_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel']);

  /* ------------------------------------------------------------------ */
  /* Настройки                                                           */
  /* ------------------------------------------------------------------ */

  const DEFAULTS = {
    language: 'auto',
    motherTongue: '',
    preferredVariants: '',
    pickyMode: false,
    disabledRules: '',
    ignoredWords: [],
    disabledSites: [],
    maxTextLength: 0,
  };

  let settings = { ...DEFAULTS };
  const sessionIgnoredRules = new Set();

  async function loadSettings() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'getSettings' });
      if (resp && !resp.error) settings = { ...DEFAULTS, ...resp };
    } catch { /* расширение недоступно */ }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
      if (siteDisabled()) {
        clearLayer();
        closeCard();
        restoreNativeSpellcheckAll();
        return;
      }
      const el = findActiveEditable();
      if (el) scheduleCheck(el, true);
    }
  });

  function siteDisabled() {
    try {
      return (settings.disabledSites || []).includes(location.hostname);
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Отключение штатной проверки орфографии Chrome                       */
  /*                                                                     */
  /* Пока расширение ведёт элемент, штатные «волнистые» подчёркивания    */
  /* отключаются (spellcheck="false"), чтобы не было двойной подсветки.  */
  /* Исходное значение атрибута возвращается при отключении проверки     */
  /* (сайт в списке исключений, выгрузка страницы).                      */
  /* ------------------------------------------------------------------ */

  const nativeSpell = new Map(); // el -> исходное значение атрибута spellcheck (string | null)

  function suppressNativeSpellcheck(el) {
    if (nativeSpell.has(el)) return;
    nativeSpell.set(el, el.hasAttribute('spellcheck') ? el.getAttribute('spellcheck') : null);
    el.setAttribute('spellcheck', 'false');
  }

  function reassertSuppression(el) {
    // редакторы (Confluence и т.п.) могут перерисовать атрибут — держим выключенным
    if (el.getAttribute('spellcheck') !== 'false') el.setAttribute('spellcheck', 'false');
  }

  function restoreNativeSpellcheckAll() {
    for (const [el, orig] of Array.from(nativeSpell)) {
      if (el.isConnected) {
        if (orig === null) el.removeAttribute('spellcheck');
        else el.setAttribute('spellcheck', orig);
      }
      nativeSpell.delete(el);
    }
  }

  window.addEventListener('pagehide', restoreNativeSpellcheckAll);

  /* ------------------------------------------------------------------ */
  /* Определение редактируемых элементов                                 */
  /* ------------------------------------------------------------------ */

  function isOurNode(node) {
    return !!(node && (node.closest && node.closest('.vdlt-root, .vdlt-card')));
  }

  function editableRoot(el) {
    if (!el || !el.tagName) return null;
    if (el.tagName === 'TEXTAREA') return el;
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return ALLOWED_INPUT_TYPES.has(type) && !el.disabled && !el.readOnly ? el : null;
    }
    if (el.isContentEditable) {
      const root = el.closest('[contenteditable="true"], [contenteditable=""]');
      return root || (document.body && document.body.isContentEditable ? document.body : null);
    }
    return null;
  }

  function findActiveEditable() {
    return editableRoot(document.activeElement);
  }

  /* ------------------------------------------------------------------ */
  /* Текстовая модель + отображение offset -> DOM                        */
  /* ------------------------------------------------------------------ */

  function buildTextModel(el) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      return { kind: 'value', el, text: el.value };
    }
    const segs = [];
    let text = '';
    let pendingNL = false;

    const pushNL = () => {
      if (!text.endsWith('\n')) {
        text += '\n';
        segs.push({ isNL: true, start: text.length - 1, len: 1 });
      }
    };

    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const data = node.nodeValue;
        if (!data) return;
        // отступы разметки между блоками не отправляем на проверку
        if (pendingNL && /^[ \t\r\n]*$/.test(data)) return;
        if (pendingNL) { pushNL(); pendingNL = false; }
        segs.push({ node, start: text.length, len: data.length });
        text += data;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (isOurNode(node)) return;
        const tag = node.tagName;
        if (tag === 'BR') { pushNL(); pendingNL = false; return; }
        if (tag === 'SCRIPT' || tag === 'STYLE') return;
        if (BLOCK_TAGS.has(tag)) pendingNL = true;
        for (const child of Array.from(node.childNodes)) walk(child);
      }
    };
    walk(el);
    return { kind: 'dom', el, text, segs };
  }

  function locate(model, pos, isEnd) {
    let anchor = null;
    for (const seg of model.segs) {
      if (seg.isNL) continue;
      const s = seg.start;
      const e = s + seg.len;
      if (pos < e || (isEnd && pos <= e)) {
        return { node: seg.node, offset: Math.max(0, Math.min(pos - s, seg.len)) };
      }
      anchor = { node: seg.node, offset: seg.len };
    }
    return anchor;
  }

  function offsetToRange(model, from, to) {
    try {
      const start = locate(model, from, false);
      const end = locate(model, to, true);
      if (!start || !end) return null;
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      return range;
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Overlay-слой подчёркиваний (общий для всех элементов страницы)       */
  /* ------------------------------------------------------------------ */

  let layer = null;

  function getLayer() {
    if (!layer || !layer.isConnected) {
      layer = document.createElement('div');
      layer.className = 'vdlt-root vdlt-layer';
      document.documentElement.appendChild(layer);
    }
    return layer;
  }

  function clearLayer() {
    if (layer) layer.textContent = '';
  }

  function classForMatch(match) {
    const issue = match.rule && match.rule.issueType;
    if (issue === 'misspelling') return 'vdlt-spelling';
    if (issue === 'grammar' || issue === 'typographical' || issue === 'duplication') return 'vdlt-grammar';
    return 'vdlt-style'; // style, inconsistencies, punctuation и прочее
  }

  /* Подчёркивания для contenteditable: rect'ы DOM Range -> div'ы */
  function renderDomUnderlines(entries) {
    for (const entry of entries) {
      for (const rect of entry.range.getClientRects()) {
        if (rect.width < 1 || rect.height < 1) continue;
        const u = document.createElement('div');
        u.className = 'vdlt-underline ' + classForMatch(entry.match);
        u.title = 'LanguageTool: ' + (entry.match.shortMessage || 'исправить ошибку');
        positionUnderline(u, rect);
        u.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openCard(entry, u.getBoundingClientRect());
        });
        getLayer().appendChild(u);
      }
    }
  }

  function positionUnderline(u, rect) {
    u.style.left = (rect.left + window.scrollX) + 'px';
    // div высотой 8px, видимая полоса прижата к низу — совпадает с низом текста
    u.style.top = (rect.bottom + window.scrollY - 8) + 'px';
    u.style.width = Math.max(2, rect.width) + 'px';
  }

  /* Измерительное «зеркало» для textarea/input: все совпадения за один проход */
  const MIRROR_STYLES = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
    'lineHeight', 'textTransform', 'wordSpacing', 'textIndent', 'boxSizing',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderStyle', 'whiteSpace', 'wordWrap', 'wordBreak', 'overflowWrap',
    'boxDecorationBreak', 'tabSize', 'webkitTextFillColor',
  ];

  let mirror = null;

  function getMirror() {
    if (!mirror || !mirror.isConnected) {
      mirror = document.createElement('div');
      mirror.className = 'vdlt-root vdlt-mirror';
      document.documentElement.appendChild(mirror);
    }
    return mirror;
  }

  function renderValueUnderlines(el, model, entries) {
    if (!entries.length) return;
    const m = getMirror();
    const cs = getComputedStyle(el);
    for (const prop of MIRROR_STYLES) {
      try { m.style[prop] = cs[prop]; } catch { /* read-only */ }
    }
    m.style.width = el.clientWidth + 'px';
    m.style.height = 'auto';
    m.style.top = '0';
    m.style.left = '0';

    // один fragment со всеми отметками: value[mark0]value[mark1]...
    const value = model.text;
    const frag = document.createDocumentFragment();
    const marks = [];
    let pos = 0;
    for (const entry of entries) {
      if (entry.from < pos || entry.to > value.length) continue;
      frag.appendChild(document.createTextNode(value.slice(pos, entry.from)));
      const mark = document.createElement('span');
      mark.textContent = value.slice(entry.from, entry.to);
      frag.appendChild(mark);
      marks.push({ mark, entry });
      pos = entry.to;
    }
    frag.appendChild(document.createTextNode(value.slice(pos)));
    m.textContent = '';
    m.appendChild(frag);

    const elRect = el.getBoundingClientRect();
    const mirrorRect = m.getBoundingClientRect();
    const scrollTop = el.scrollTop;
    const scrollLeft = el.scrollLeft;
    for (const { mark, entry } of marks) {
      for (const rect of mark.getClientRects()) {
        if (rect.width < 1) continue;
        const u = document.createElement('div');
        u.className = 'vdlt-underline ' + classForMatch(entry.match);
        u.title = 'LanguageTool: ' + (entry.match.shortMessage || 'исправить ошибку');
        u.style.left = (elRect.left + rect.left - mirrorRect.left - scrollLeft) + 'px';
        u.style.top = (elRect.top + rect.top - mirrorRect.top - scrollTop + rect.height - 8) + 'px';
        u.style.width = Math.max(2, rect.width) + 'px';
        u.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openCard(entry, u.getBoundingClientRect());
        });
        getLayer().appendChild(u);
      }
    }
  }

  /* Перерисовка позиций при скролле/resize */
  let rafPending = false;
  function scheduleReposition() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const active = currentEntries.el;
      if (active && active.isConnected) render(active, true);
    });
  }

  window.addEventListener('scroll', scheduleReposition, { passive: true, capture: true });
  window.addEventListener('resize', scheduleReposition, { passive: true });

  /* ------------------------------------------------------------------ */
  /* Проверка текста                                                     */
  /* ------------------------------------------------------------------ */

  const state = new WeakMap(); // el -> {timer, seq, model, matches, shift, textSessionId}

  function st(el) {
    if (!state.has(el)) {
      state.set(el, { timer: null, seq: 0, model: null, matches: [], shift: 0, textSessionId: (Math.random() * 1e9) | 0 });
    }
    return state.get(el);
  }

  function scheduleCheck(el, immediate) {
    if (siteDisabled()) {
      clearLayer();
      closeCard();
      restoreNativeSpellcheckAll();
      return;
    }
    const s = st(el);
    clearTimeout(s.timer);
    s.timer = setTimeout(() => runCheck(el), immediate ? 50 : DEBOUNCE_MS);
  }

  async function runCheck(el) {
    if (!el.isConnected) return;
    const s = st(el);
    suppressNativeSpellcheck(el);
    reassertSuppression(el);
    const model = buildTextModel(el);
    s.model = model;

    let text = model.text;
    if (!text || text.trim().length < MIN_TEXT_LEN) {
      s.matches = [];
      render(el);
      return;
    }

    let shift = 0;
    const maxLen = settings.maxTextLength | 0;
    if (maxLen > 0 && text.length > maxLen) {
      shift = text.length - maxLen;
      text = text.slice(shift); // проверяем конец текста — там обычно редактируют
    }

    const seq = ++s.seq;
    const params = {
      language: settings.language || 'auto',
      disabledRules: [...sessionIgnoredRules].join(','),
      textSessionId: s.textSessionId,
    };
    const resp = await chrome.runtime.sendMessage({ type: 'check', text, params }).catch(() => null);
    if (!resp || resp.error || seq !== s.seq || !el.isConnected) {
      if (resp && resp.error && seq === s.seq) {
        s.matches = [];
        render(el, false, resp.error);
      }
      return;
    }
    s.matches = Array.isArray(resp.matches) ? resp.matches : [];
    s.shift = shift;
    render(el);
  }

  function isSpellingMatch(match) {
    const issue = match.rule && match.rule.issueType;
    const cat = match.rule && match.rule.category && match.rule.category.id;
    return issue === 'misspelling' || cat === 'TYPOS';
  }

  function filterMatches(matches, model, shift) {
    const words = new Set((settings.ignoredWords || []).map((w) => w.toLowerCase()));
    const out = [];
    for (const match of matches) {
      if (out.length >= MAX_RENDERED) break;
      const from = match.offset + shift;
      const to = from + match.length;
      if (from < 0 || to > model.text.length || to <= from) continue;
      const ruleId = match.rule && match.rule.id;
      if (ruleId && sessionIgnoredRules.has(ruleId)) continue;
      if (words.size && isSpellingMatch(match)) {
        const word = model.text.slice(from, to).toLowerCase();
        if (words.has(word)) continue;
      }
      out.push({ match, from, to });
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Отрисовка результата                                                */
  /* ------------------------------------------------------------------ */

  const currentEntries = { el: null, list: [] };

  function render(el, keepMatches, checkError) {
    const s = st(el);
    clearLayer();
    if (currentEntries.el === el) currentEntries.list = [];

    if (!el.isConnected) return;

    if (checkError) {
      showLayerError(checkError);
      return;
    }
    if (!s.model || !s.matches) return;

    const entries = filterMatches(s.matches, s.model, s.shift);
    currentEntries.el = el;
    currentEntries.list = entries;

    if (!entries.length) {
      closeCard();
      updateBadge(el, 0);
      return;
    }

    if (s.model.kind === 'value') {
      renderValueUnderlines(el, s.model, entries);
    } else {
      for (const entry of entries) {
        const range = offsetToRange(s.model, entry.from, entry.to);
        if (!range) continue;
        renderDomUnderlines([{ match: entry.match, range }]);
      }
    }
    updateBadge(el, entries.length);
  }

  function showLayerError(code) {
    const el = findActiveEditable();
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width) return;
    const tag = document.createElement('div');
    tag.className = 'vdlt-err-tag';
    const errText = {
      NETWORK: 'LanguageTool: сервер недоступен',
      SERVER_NOT_CONFIGURED: 'LanguageTool: сервер не настроен',
      INSECURE_SERVER: 'LanguageTool: подтвердите HTTP-сервер в настройках',
      NO_SERVER_ACCESS: 'LanguageTool: нет доступа к серверу (настройки)',
    }[code];
    tag.textContent = errText || 'LanguageTool: ошибка проверки (' + code + ')';
    tag.style.left = Math.max(4, rect.left + window.scrollX) + 'px';
    tag.style.top = Math.max(4, rect.top + window.scrollY - 22) + 'px';
    getLayer().appendChild(tag);
    setTimeout(() => { if (tag.isConnected) tag.remove(); }, 2500);
  }

  function updateBadge(el, count) {
    if (el !== document.activeElement || !document.hasFocus()) return;
    chrome.runtime.sendMessage({ type: 'badge', count }).catch(() => {});
  }

  /* ------------------------------------------------------------------ */
  /* Карточка с вариантами исправления                                   */
  /* ------------------------------------------------------------------ */

  let card = null;

  function closeCard() {
    if (card) { card.remove(); card = null; }
  }

  /* Ссылки из ответа сервера допускаются только с http/https-схемой:
   * скомпрометированный сервер не сможет подсунуть javascript:/data: URL,
   * исполняемый в контексте страницы при клике по «Подробнее…». */
  function safeHttpUrl(raw) {
    try {
      const u = new URL(String(raw));
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
    } catch {
      return null;
    }
  }

  function openCard(entry, anchorRect) {
    closeCard();
    const { match } = entry;

    card = document.createElement('div');
    card.className = 'vdlt-root vdlt-card';

    const cat = match.rule && match.rule.category && match.rule.category.name;
    const issueRu = {
      misspelling: 'Орфография',
      grammar: 'Грамматика',
      typographical: 'Опечатка',
      style: 'Стиль',
      duplication: 'Повтор',
      inconsistency: 'Несогласованность',
      punctuation: 'Пунктуация',
    }[match.rule && match.rule.issueType] || (cat || 'Замечание');

    const head = document.createElement('div');
    head.className = 'vdlt-card-head';
    head.textContent = issueRu;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'vdlt-card-close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', closeCard);
    head.appendChild(closeBtn);
    card.appendChild(head);

    const msg = document.createElement('div');
    msg.className = 'vdlt-card-msg';
    msg.textContent = match.shortMessage || match.message || '';
    card.appendChild(msg);

    const repls = (match.replacements || []).slice(0, 8);
    if (repls.length) {
      const list = document.createElement('div');
      list.className = 'vdlt-card-repls';
      for (const r of repls) {
        const btn = document.createElement('button');
        btn.className = 'vdlt-card-repl';
        btn.textContent = r.value;
        btn.title = r.shortDescription || '';
        btn.addEventListener('mousedown', (ev) => ev.preventDefault());
        btn.addEventListener('click', () => applyReplacement(entry, r.value));
        list.appendChild(btn);
      }
      card.appendChild(list);
    }

    const foot = document.createElement('div');
    foot.className = 'vdlt-card-foot';
    if (match.rule && match.rule.id) {
      const ig = document.createElement('button');
      ig.className = 'vdlt-card-action';
      ig.textContent = 'Отключить правило';
      ig.title = 'Не показывать это правило на этой странице';
      ig.addEventListener('click', () => {
        sessionIgnoredRules.add(match.rule.id);
        const el = currentEntries.el;
        closeCard();
        if (el) scheduleCheck(el, true);
      });
      foot.appendChild(ig);
    }
    const ctx = match.context && match.context.text ? match.context.text.slice(
      match.context.offset, match.context.offset + match.length) : null;
    if (isSpellingMatch(match) && ctx) {
      const dic = document.createElement('button');
      dic.className = 'vdlt-card-action';
      dic.textContent = 'В словарь';
      dic.title = 'Добавить «' + ctx + '» в личный словарь';
      dic.addEventListener('click', async () => {
        const el = currentEntries.el;
        await chrome.runtime.sendMessage({ type: 'addWord', word: ctx }).catch(() => {});
        await loadSettings();
        closeCard();
        if (el) scheduleCheck(el, true);
      });
      foot.appendChild(dic);
    }
    if (foot.childNodes.length) card.appendChild(foot);

    const moreUrl = safeHttpUrl(
      match.rule && match.rule.urls && match.rule.urls[0] && match.rule.urls[0].value);
    if (moreUrl) {
      const more = document.createElement('a');
      more.className = 'vdlt-card-more';
      more.href = moreUrl;
      more.target = '_blank';
      more.rel = 'noopener noreferrer';
      more.textContent = 'Подробнее…';
      card.appendChild(more);
    }

    document.documentElement.appendChild(card);

    const cw = card.offsetWidth || 280;
    const ch = card.offsetHeight || 120;
    let left = anchorRect.left;
    let top = anchorRect.bottom + 6;
    if (left + cw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - cw - 8);
    if (top + ch > window.innerHeight - 8) top = Math.max(8, anchorRect.top - ch - 6);
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  }

  document.addEventListener('mousedown', (ev) => {
    if (card && !ev.target.closest('.vdlt-root')) closeCard();
  }, true);

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && card) closeCard();
  }, true);

  /* ------------------------------------------------------------------ */
  /* Применение исправления                                              */
  /* ------------------------------------------------------------------ */

  function applyReplacement(entry, value) {
    const el = currentEntries.el;
    if (!el || !el.isConnected) return;
    const s = st(el);
    const model = buildTextModel(el);
    // защищаемся от применения к изменившемуся тексту
    const current = model.kind === 'value'
      ? model.text.slice(entry.from, entry.to)
      : sliceModel(model, entry.from, entry.to);
    const ctxText = entry.match.context && entry.match.context.text
      ? entry.match.context.text.slice(
          entry.match.context.offset,
          entry.match.context.offset + entry.match.length)
      : current;
    if (current !== ctxText && ctxText) {
      scheduleCheck(el, true);
      return;
    }

    closeCard();

    if (model.kind === 'value') {
      el.focus();
      el.setRangeText(value, entry.from, entry.to, 'end');
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: true, inputType: 'insertText', data: value,
      }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const range = offsetToRange(model, entry.from, entry.to);
      if (!range) return;
      el.focus();
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      let ok = false;
      try { ok = document.execCommand('insertText', false, value); } catch { ok = false; }
      if (!ok) {
        range.deleteContents();
        range.insertNode(document.createTextNode(value));
        range.collapse(false);
        el.dispatchEvent(new InputEvent('input', {
          bubbles: true, cancelable: true, inputType: 'insertText', data: value,
        }));
      }
    }
    s.matches = [];
    clearLayer();
    scheduleCheck(el, true);
  }

  function sliceModel(model, from, to) {
    let out = '';
    for (const seg of model.segs) {
      const s = seg.start;
      const e = s + seg.len;
      if (e <= from || s >= to) continue;
      const a = Math.max(0, from - s);
      const b = Math.min(seg.len, to - s);
      out += seg.isNL ? '\n' : seg.node.nodeValue.slice(a, b);
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* События                                                             */
  /* ------------------------------------------------------------------ */

  document.addEventListener('focusin', () => {
    const el = findActiveEditable();
    if (el && !siteDisabled()) {
      suppressNativeSpellcheck(el); // сразу убираем двойную подсветку при фокусе
      scheduleCheck(el, false);
    }
  });

  document.addEventListener('input', (ev) => {
    if (ev.isComposing) return;
    const el = editableRoot(ev.target);
    if (!el) return;
    closeCard();
    scheduleCheck(el, false);
  }, true);

  /* ------------------------------------------------------------------ */

  loadSettings().then(() => {
    const el = findActiveEditable();
    if (el) scheduleCheck(el, true);
  });
})();
