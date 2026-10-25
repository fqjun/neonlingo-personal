// NeonLingo 个人版内容脚本：整页替换、全网高亮生词、悬停卡片、划词翻译。
// 经典脚本（不能 import），所有模型调用和存储都通过后台消息完成。
(() => {
  if (window.__neonLingoLoaded) return;
  window.__neonLingoLoaded = true;

  const SKIP_SELECTOR =
    'script,style,noscript,textarea,input,select,option,button,code,pre,kbd,samp,svg,canvas,math,iframe,[contenteditable],nl-root,.nl-word,.nl-hl';
  const CJK_RE = /[一-鿿]/g;
  const MIN_CJK = 6;
  const BATCH_CHARS = 1500;
  const MAX_SAME_WORD_PER_PAGE = 2;

  let settings = null;
  let vocabMap = new Map(); // key → { w, m, p, pos, st, seen }
  let active = false;
  let charsUsed = 0;
  let queue = [];
  let inflight = 0;
  let flushTimer = null;
  let io = null;
  let mo = null;
  const pending = new WeakMap(); // element → text nodes 等待进入视口
  // 已经排队或处理过的文本节点，以及插件自己拆分生成的文本片段。
  // 替换时原文会被拆成「片段 + 英文词 + 片段」，这些片段不能再被当作新内容送去替换，否则同一段会被反复加词。
  let handled = new WeakSet();
  const ownText = (str) => {
    const t = document.createTextNode(str);
    handled.add(t);
    return t;
  };
  const wordCount = new Map(); // 本页每个英文词已替换次数
  const seenReported = new Set();
  const seenPending = new Set();
  let seenTimer = null;
  let errorShown = false;

  const keyOf = (w) => String(w || '').trim().toLowerCase();

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: { code: 'internal', message: chrome.runtime.lastError.message } });
          else resolve(res || { ok: false, error: { code: 'internal', message: '无响应' } });
        });
      } catch (e) {
        // 扩展被重新加载后旧页面里的脚本会失效
        resolve({ ok: false, error: { code: 'internal', message: String(e.message || e) } });
      }
    });
  }

  // ---------------- 初始化 ----------------

  async function init() {
    const res = await send({ type: 'init', url: location.href });
    if (!res.ok) return;
    settings = res.data.settings;
    applyTheme();
    setVocab(res.data.vocab);
    active = settings.enabled && !res.data.blocked;
    if (!active) return;
    if (settings.globalHighlight) highlightIn(document.body);
    if (isChinesePage()) startReplacing();
    observeMutations();
  }

  function setVocab(list) {
    vocabMap = new Map(list.map((v) => [keyOf(v.w), v]));
    hlRegex = null;
  }

  function applyTheme() {
    const root = document.documentElement;
    root.style.setProperty('--nl-color', settings.highlightColor);
    root.style.setProperty('--nl-lookup-color', settings.lookupColor);
    root.dataset.nlStyle = settings.highlightStyle;
  }

  function isChinesePage() {
    const lang = (document.documentElement.lang || '').toLowerCase();
    if (lang.startsWith('zh')) return true;
    const sample = (document.body?.textContent || '').slice(0, 5000);
    const cjk = (sample.match(CJK_RE) || []).length;
    return cjk > 50 && cjk / Math.max(1, sample.replace(/\s/g, '').length) > 0.2;
  }

  // 设置变化时整页复原后重新处理
  let reinitTimer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
      clearTimeout(reinitTimer);
      reinitTimer = setTimeout(reset, 600);
    }
  });

  async function reset() {
    stopObservers();
    hideCard(true);
    document.querySelectorAll('.nl-word').forEach((s) => s.replaceWith(document.createTextNode(s.dataset.nlOrig)));
    document.querySelectorAll('.nl-hl').forEach((s) => s.replaceWith(document.createTextNode(s.textContent)));
    document.body.normalize();
    // 复原后的整段原文要重新处理：normalize 可能把它合并进旧片段节点，所以清空标记
    handled = new WeakSet();
    queue = [];
    charsUsed = 0;
    wordCount.clear();
    await init();
  }

  function stopObservers() {
    io?.disconnect();
    mo?.disconnect();
    io = mo = null;
  }

  // ---------------- 整页替换 ----------------

  function collectTextNodes(root) {
    const nodes = [];
    if (!root) return nodes;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || p.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        if (handled.has(node)) return NodeFilter.FILTER_REJECT;
        const m = node.nodeValue.match(CJK_RE);
        return m && m.length >= MIN_CJK ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function startReplacing() {
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io.unobserve(e.target);
          const nodes = pending.get(e.target);
          pending.delete(e.target);
          if (nodes) queue.push(...nodes);
        }
        scheduleFlush();
      },
      { rootMargin: '600px 0px' },
    );
    watchNodes(collectTextNodes(document.body));
  }

  function watchNodes(nodes) {
    for (const n of nodes) {
      const el = n.parentElement;
      if (!el || handled.has(n)) continue;
      handled.add(n);
      const list = pending.get(el);
      if (list) list.push(n);
      else {
        pending.set(el, [n]);
        io.observe(el);
      }
    }
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 300);
  }

  function flush() {
    while (queue.length && inflight < 2) {
      const batch = [];
      let size = 0;
      while (queue.length && size < BATCH_CHARS) {
        const n = queue.shift();
        if (!n.isConnected || n.parentElement?.closest(SKIP_SELECTOR)) continue;
        const len = n.nodeValue.length;
        if (charsUsed + len > settings.maxCharsPerPage) {
          queue = [];
          break;
        }
        charsUsed += len;
        size += len;
        batch.push(n);
      }
      if (!batch.length) break;
      inflight++;
      processBatch(batch).finally(() => {
        inflight--;
        flush();
      });
    }
  }

  async function processBatch(nodes) {
    const items = nodes.map((n, i) => ({ id: String(i), text: n.nodeValue }));
    const res = await send({ type: 'translatePage', items, url: location.href });
    if (!res.ok) {
      showError(res.error);
      return;
    }
    for (const it of res.data.items) {
      const i = Number(it.id);
      const node = nodes[i];
      if (node?.isConnected && node.nodeValue === items[i].text && it.replacements.length) applyReplacements(node, it.replacements);
    }
  }

  function applyReplacements(node, reps) {
    const text = node.nodeValue;
    const ranges = [];
    for (const r of reps) {
      const key = keyOf(r.word);
      if ((wordCount.get(key) || 0) >= MAX_SAME_WORD_PER_PAGE) continue;
      let idx = text.indexOf(r.original);
      while (idx !== -1 && ranges.some((x) => idx < x.end && idx + r.original.length > x.start)) {
        idx = text.indexOf(r.original, idx + 1);
      }
      if (idx === -1) continue;
      ranges.push({ start: idx, end: idx + r.original.length, r });
      wordCount.set(key, (wordCount.get(key) || 0) + 1);
    }
    if (!ranges.length) return;
    ranges.sort((a, b) => a.start - b.start);

    const sentence = text.trim().slice(0, 300);
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const { start, end, r } of ranges) {
      if (start > pos) frag.appendChild(ownText(text.slice(pos, start)));
      frag.appendChild(makeWordSpan(r, sentence));
      pos = end;
      reportSeen(r.word);
    }
    if (pos < text.length) frag.appendChild(ownText(text.slice(pos)));
    node.replaceWith(frag);
  }

  function makeWordSpan(r, sentence) {
    const s = document.createElement('span');
    s.className = 'nl-word';
    Object.assign(s.dataset, {
      nlWord: r.word.trim(),
      nlOrig: r.original,
      nlMeaning: r.meaning,
      nlPhonetic: r.phonetic,
      nlPos: r.pos,
      nlSentence: sentence,
    });
    renderWordSpan(s);
    return s;
  }

  function renderWordSpan(s) {
    const v = vocabMap.get(keyOf(s.dataset.nlWord));
    s.classList.toggle('nl-learning', v?.st === 'learning');
    s.classList.toggle('nl-looked', isLooked(v));
    if (s.classList.contains('nl-show-orig')) s.textContent = s.dataset.nlOrig;
    else s.textContent = settings.displayMode === 'en_zh' ? `${s.dataset.nlWord}(${s.dataset.nlOrig})` : s.dataset.nlWord;
  }

  function refreshWord(word) {
    const key = keyOf(word);
    document.querySelectorAll('.nl-word').forEach((s) => {
      if (keyOf(s.dataset.nlWord) === key) renderWordSpan(s);
    });
    document.querySelectorAll('.nl-hl').forEach((s) => {
      if (keyOf(s.dataset.nlWord) === key) s.classList.toggle('nl-looked', isLooked(vocabMap.get(key)));
    });
    hlRegex = null;
  }

  // 查词收藏、仍在学习中的词，用查词颜色提示
  const isLooked = (v) => v?.st === 'learning' && v.src === 'lookup';

  const toSummary = (e) => ({ w: e.word, m: e.meaning, p: e.phonetic, pos: e.pos, st: e.status, seen: e.seen, src: e.source });

  // 生词本里的词在本页出现时记一次曝光（每页每词只记一次，批量上报）
  function reportSeen(word) {
    const key = keyOf(word);
    if (seenReported.has(key) || !vocabMap.has(key)) return;
    seenReported.add(key);
    seenPending.add(key);
    clearTimeout(seenTimer);
    seenTimer = setTimeout(() => {
      const words = [...seenPending];
      seenPending.clear();
      send({ type: 'vocab:seen', words });
    }, 2000);
  }

  function showError(err) {
    if (errorShown) return;
    errorShown = true;
    const hint = err.code === 'no_key' || err.code === 'auth' ? '（点击扩展图标 → 设置）' : '';
    toast(`NeonLingo：${err.message}${hint}`);
  }

  // ---------------- 全网高亮：生词本中在学的英文词 ----------------

  let hlRegex = null;

  function buildHlRegex() {
    const words = [...vocabMap.values()]
      .filter((v) => v.st === 'learning' && /^[a-z][a-z '\-]*$/i.test(v.w))
      .map((v) => v.w.trim().toLowerCase())
      .sort((a, b) => b.length - a.length)
      .slice(0, 800);
    if (!words.length) return null;
    const alts = words.map((w) => w.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'));
    // 允许常见词形变化：复数、过去式、进行时
    return new RegExp(`\\b(${alts.join('|')})(?:s|es|d|ed|ing)?\\b`, 'gi');
  }

  function highlightIn(root) {
    if (!root) return;
    if (!hlRegex) hlRegex = buildHlRegex();
    if (!hlRegex) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || p.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        return /[a-z]{2}/i.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue;
      hlRegex.lastIndex = 0;
      let m;
      let pos = 0;
      let frag = null;
      while ((m = hlRegex.exec(text))) {
        const v = vocabMap.get(m[1].toLowerCase());
        if (!v) continue;
        frag ||= document.createDocumentFragment();
        if (m.index > pos) frag.appendChild(ownText(text.slice(pos, m.index)));
        const s = document.createElement('span');
        s.className = isLooked(v) ? 'nl-hl nl-looked' : 'nl-hl';
        s.dataset.nlWord = v.w;
        s.dataset.nlSentence = text.trim().slice(0, 300);
        s.textContent = m[0];
        frag.appendChild(s);
        pos = m.index + m[0].length;
        reportSeen(v.w);
      }
      if (frag) {
        if (pos < text.length) frag.appendChild(ownText(text.slice(pos)));
        node.replaceWith(frag);
      }
    }
  }

  // ---------------- 动态内容 ----------------

  function observeMutations() {
    const added = new Set();
    let timer = null;
    mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          // 跳过插件自己插入的替换词、高亮词和拆分片段，只处理网页真正新加载的内容
          if (n.nodeType === 1 && !n.matches('.nl-word,.nl-hl,nl-root')) added.add(n);
          else if (n.nodeType === 3 && !handled.has(n) && n.parentElement && !n.parentElement.closest('.nl-word,.nl-hl')) {
            added.add(n.parentElement);
          }
        }
      }
      if (!added.size) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const roots = [...added].filter((n) => n.isConnected);
        added.clear();
        for (const r of roots) {
          if (settings.globalHighlight) highlightIn(r);
          if (io) watchNodes(collectTextNodes(r));
        }
      }, 800);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // ---------------- 卡片（Shadow DOM，避免被网页样式干扰） ----------------

  let host = null;
  let shadow = null;
  let card = null;
  let selIcon = null;
  let hideTimer = null;
  let showTimer = null;
  let currentAnchor = null;

  function ensureHost() {
    if (host?.isConnected) return;
    host = document.createElement('nl-root');
    host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; z-index: 2147483647;';
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CARD_CSS}</style><div class="card" hidden></div><button class="sel-icon" hidden title="NeonLingo 翻译">译</button><div class="toast" hidden></div>`;
    card = shadow.querySelector('.card');
    selIcon = shadow.querySelector('.sel-icon');
    card.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    card.addEventListener('mouseleave', () => scheduleHide());
    card.addEventListener('click', onCardClick);
    selIcon.addEventListener('mousedown', (e) => e.preventDefault());
    selIcon.addEventListener('click', () => {
      const info = selIcon._info;
      selIcon.hidden = true;
      if (info) doLookup(info);
    });
  }

  function positionCard(rect) {
    card.style.setProperty('--nl-color', settings.highlightColor);
    card.style.setProperty('--nl-lookup-color', settings.lookupColor);
    card.hidden = false;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top;
    let left;
    if (settings.cardPosition === 'corner' || !rect) {
      top = vh - ch - 20;
      left = vw - cw - 20;
    } else if (settings.cardPosition === 'right') {
      left = rect.right + 10;
      top = rect.top - 8;
      if (left + cw > vw - 8) left = rect.left - cw - 10;
    } else {
      left = rect.left;
      top = rect.bottom + 8;
      if (top + ch > vh - 8) top = rect.top - ch - 8;
    }
    card.style.left = Math.max(8, Math.min(left, vw - cw - 8)) + 'px';
    card.style.top = Math.max(8, Math.min(top, vh - ch - 8)) + 'px';
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => hideCard(), 350);
  }

  function hideCard(force) {
    clearTimeout(showTimer);
    if (!card) return;
    if (force || !card.matches(':hover')) {
      card.hidden = true;
      currentAnchor = null;
    }
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function statusLine(v) {
    if (!v) return '<span class="tag">新词</span><span class="muted">双击单词可加入生词本</span>';
    if (v.st === 'mastered') return '<span class="tag ok">已掌握</span>';
    const looked = v.src === 'lookup' ? '<span class="tag looked">查过</span>' : '';
    return `<span class="tag learn">学习中</span>${looked}<span class="muted">见过 ${v.seen || 0} 次</span>`;
  }

  // data: { word, phonetic, pos, meaning, original?, other?, exEn?, exZh?, note?, sentence, kind: 'replace'|'hl'|'lookup' }
  function renderCard(data) {
    const v = vocabMap.get(keyOf(data.word));
    const saved = v?.st === 'learning';
    card._data = data;
    card.innerHTML = `
      <div class="head">
        <span class="word">${esc(data.word)}</span>
        <button class="icon" data-act="speak" title="发音">🔊</button>
        <span class="spacer"></span>
        <button class="icon star ${saved ? 'on' : ''}" data-act="star" title="${saved ? '取消收藏' : '加入生词本'}">${saved ? '★' : '☆'}</button>
      </div>
      <div class="phon">${esc(data.phonetic)}</div>
      <div class="mean"><span class="pos">${esc(data.pos)}</span> ${esc(data.meaning)}</div>
      ${data.original ? `<div class="muted">原文：${esc(data.original)}</div>` : ''}
      ${data.other?.length ? `<div class="muted">其他：${esc(data.other.join('；'))}</div>` : ''}
      ${data.exEn ? `<div class="ex">${esc(data.exEn)}<br><span class="muted">${esc(data.exZh)}</span></div>` : ''}
      ${data.note ? `<div class="note">${esc(data.note)}</div>` : ''}
      <div class="status">${statusLine(v)}</div>
      ${
        data.kind === 'lookup'
          ? ''
          : `<div class="actions">
        <button data-act="known">✓ 认识</button>
        <button data-act="unknown">✗ 不认识</button>
      </div>`
      }`;
  }

  function showCardFor(el) {
    ensureHost();
    const d = el.dataset;
    let data;
    if (el.classList.contains('nl-word')) {
      data = spanData(el);
    } else {
      const v = vocabMap.get(keyOf(d.nlWord)) || {};
      data = { kind: 'hl', word: v.w || d.nlWord, phonetic: v.p, pos: v.pos, meaning: v.m, sentence: d.nlSentence };
    }
    currentAnchor = el;
    renderCard(data);
    positionCard(el.getBoundingClientRect());
  }

  async function onCardClick(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const data = card._data;
    const act = btn.dataset.act;
    if (act === 'speak') return speak(data.word);
    await markWord(data, act);
  }

  // 卡片按钮和双击共用：act 为 'star' | 'known' | 'unknown'
  async function markWord(data, act) {
    const info = {
      word: data.word,
      meaning: data.meaning,
      phonetic: data.phonetic,
      pos: data.pos,
      original: data.original || '',
      source: data.kind === 'lookup' ? 'lookup' : 'page',
    };
    const example = data.sentence ? { s: data.sentence, url: location.href, title: document.title } : null;
    const v = vocabMap.get(keyOf(data.word));
    let res;
    if (act === 'star') {
      res = v?.st === 'learning'
        ? await send({ type: 'vocab:mark', word: data.word, action: 'remove' })
        : await send({ type: 'vocab:add', info, status: 'learning', example });
    } else if (act === 'known') {
      res = await send({ type: 'vocab:mark', word: data.word, action: 'known', info, example });
    } else if (act === 'unknown') {
      res = await send({ type: 'vocab:mark', word: data.word, action: 'unknown', info, example });
      speak(data.word);
    }
    if (!res?.ok) return toast('操作失败：' + (res?.error?.message || ''));
    const entry = res.data;
    if (entry) vocabMap.set(keyOf(entry.word), toSummary(entry));
    else vocabMap.delete(keyOf(data.word));
    refreshWord(data.word);
    if (entry && data.kind === 'lookup' && active && settings.globalHighlight) highlightIn(document.body);
    if (card && !card.hidden && card._data && keyOf(card._data.word) === keyOf(data.word)) renderCard(card._data);
    if (act === 'known' && entry?.status === 'mastered') {
      toast(`「${entry.word}」已掌握${settings.wordDifficulty === 'review' ? '，会在「轻松巩固」中继续出现' : '，之后不再替换'}`);
    }
    return entry;
  }

  function spanData(el) {
    const d = el.dataset;
    return { kind: 'replace', word: d.nlWord, phonetic: d.nlPhonetic, pos: d.nlPos, meaning: d.nlMeaning, original: d.nlOrig, sentence: d.nlSentence };
  }

  function speak(word) {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(word);
      u.lang = 'en-US';
      u.rate = settings.speechRate || 0.9;
      const voice = speechSynthesis.getVoices().find((x) => x.lang === 'en-US');
      if (voice) u.voice = voice;
      speechSynthesis.speak(u);
    } catch {}
  }

  function toast(text) {
    ensureHost();
    const t = shadow.querySelector('.toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => (t.hidden = true), 4000);
  }

  // 悬停
  document.addEventListener('mouseover', (e) => {
    if (!active) return;
    const el = e.target.closest?.('.nl-word,.nl-hl');
    if (!el) return;
    clearTimeout(hideTimer);
    if (el === currentAnchor && card && !card.hidden) return;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => showCardFor(el), 250);
  });
  document.addEventListener('mouseout', (e) => {
    const el = e.target.closest?.('.nl-word,.nl-hl');
    if (!el) return;
    clearTimeout(showTimer);
    scheduleHide();
  });
  // 单击替换词：在英文和原文之间切换；双击：标记「不认识」加入生词本。
  // 单击延迟执行，若在等待期间发生双击则取消，避免双击时来回闪烁。
  let clickTimer = null;
  document.addEventListener('click', (e) => {
    const el = e.target.closest?.('.nl-word');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(clickTimer);
    if (e.detail > 1) return;
    clickTimer = setTimeout(() => {
      el.classList.toggle('nl-show-orig');
      renderWordSpan(el);
    }, 250);
  }, true);
  // 阻止双击替换词时选中文字（否则会触发划词翻译）
  document.addEventListener('mousedown', (e) => {
    if (e.detail > 1 && e.target.closest?.('.nl-word')) e.preventDefault();
  }, true);
  document.addEventListener('dblclick', async (e) => {
    const el = e.target.closest?.('.nl-word');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(clickTimer);
    window.getSelection()?.removeAllRanges();
    const data = spanData(el);
    const entry = await markWord(data, 'unknown');
    if (entry) {
      speak(entry.word);
      flash(el);
      toast(`已加入生词本：${entry.word}  ${entry.meaning || ''}`);
    }
  }, true);

  function flash(el) {
    el.classList.remove('nl-flash');
    void el.offsetWidth;
    el.classList.add('nl-flash');
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideCard(true);
      if (selIcon) selIcon.hidden = true;
    }
  });
  window.addEventListener('scroll', () => {
    if (card && !card.hidden && settings?.cardPosition !== 'corner') hideCard(true);
    if (selIcon) selIcon.hidden = true;
  }, { passive: true });

  // ---------------- 划词翻译 ----------------

  function selectionInfo() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const text = sel.toString().trim();
    if (!text || text.length > 60 || !/[a-z一-鿿]/i.test(text)) return null;
    const range = sel.getRangeAt(0);
    const anchor = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    if (!anchor || anchor.closest('input,textarea,[contenteditable]')) return null;
    const block = anchor.closest('p,li,td,h1,h2,h3,h4,h5,h6,blockquote,article,section,div') || anchor;
    const full = (block.innerText || block.textContent || '').replace(/\s+/g, ' ');
    const i = full.indexOf(text);
    const context = i === -1 ? text : full.slice(Math.max(0, i - 150), i + text.length + 150);
    return { text, context, rect: range.getBoundingClientRect() };
  }

  document.addEventListener('mouseup', (e) => {
    if (!settings || settings.selectionMode === 'off' || !settings.enabled) return;
    if (host && e.composedPath().includes(host)) return;
    if (e.target.closest?.('.nl-word')) return;
    setTimeout(() => {
      const info = selectionInfo();
      ensureHost();
      if (!info) {
        selIcon.hidden = true;
        return;
      }
      if (settings.selectionMode === 'auto') return doLookup(info);
      selIcon._info = info;
      selIcon.hidden = false;
      selIcon.style.left = Math.min(info.rect.right + 4, window.innerWidth - 36) + 'px';
      selIcon.style.top = Math.max(4, info.rect.top - 32) + 'px';
    }, 10);
  });

  async function doLookup(info) {
    ensureHost();
    currentAnchor = null;
    card._data = null;
    card.innerHTML = `<div class="loading">正在翻译「${esc(info.text)}」…</div>`;
    positionCard(info.rect);
    const res = await send({ type: 'lookup', text: info.text, context: info.context, url: location.href, title: document.title });
    if (!res.ok) {
      card.innerHTML = `<div class="err">${esc(res.error.message)}</div>`;
      positionCard(info.rect);
      return;
    }
    const { result: r, entry } = res.data;
    if (entry) {
      // 查词自动收藏后，立刻在本页用查词颜色标出这个词
      vocabMap.set(keyOf(entry.word), toSummary(entry));
      refreshWord(entry.word);
      if (active && settings.globalHighlight) highlightIn(document.body);
    }
    renderCard({
      kind: 'lookup',
      word: r.word,
      phonetic: r.phonetic,
      pos: r.pos,
      meaning: r.meaning,
      original: /[一-鿿]/.test(info.text) ? info.text : '',
      other: r.other_meanings,
      exEn: r.example_en,
      exZh: r.example_zh,
      note: r.note,
      sentence: info.context,
    });
    positionCard(info.rect);
    clearTimeout(hideTimer);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'lookupSelection') {
      const info = selectionInfo() || { text: msg.text, context: msg.text, rect: null };
      doLookup(info);
    }
  });

  // 点击卡片外部时关闭查词卡片
  document.addEventListener('mousedown', (e) => {
    if (card && !card.hidden && host && !e.composedPath().includes(host)) hideCard(true);
  });

  const CARD_CSS = `
    :host { --c: var(--nl-color, #7c3aed); }
    .card, .toast, .sel-icon {
      font: 14px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: #1f1f29; background: #fff; box-sizing: border-box;
    }
    .card {
      position: fixed; width: 300px; max-width: calc(100vw - 16px); padding: 12px 14px;
      border-radius: 12px; border: 1px solid #e6e3f0; box-shadow: 0 10px 30px rgba(20, 10, 60, .18);
      --c: var(--nl-color, #7c3aed);
    }
    [hidden] { display: none !important; }
    .head { display: flex; align-items: center; gap: 6px; }
    .word { font-size: 20px; font-weight: 700; color: var(--c); }
    .spacer { flex: 1; }
    .phon { color: #6b6880; font-size: 13px; margin-top: 2px; }
    .mean { margin-top: 6px; font-size: 15px; }
    .pos { color: #6b6880; font-style: italic; margin-right: 2px; }
    .muted { color: #6b6880; font-size: 12.5px; margin-top: 4px; }
    .ex { margin-top: 8px; padding: 6px 8px; background: #f6f4fb; border-radius: 8px; font-size: 13px; }
    .note { margin-top: 6px; font-size: 12.5px; color: #4b4860; }
    .status { margin-top: 8px; display: flex; align-items: center; gap: 8px; }
    .tag { font-size: 12px; padding: 1px 8px; border-radius: 999px; background: #eceaf3; color: #4b4860; }
    .tag.learn { background: color-mix(in srgb, var(--c) 15%, white); color: var(--c); }
    .tag.ok { background: #e3f6ea; color: #1d7a45; }
    .tag.looked { background: color-mix(in srgb, var(--nl-lookup-color, #f59e0b) 18%, white); color: color-mix(in srgb, var(--nl-lookup-color, #f59e0b) 70%, black); }
    .status .muted { margin: 0; }
    .actions { display: flex; gap: 8px; margin-top: 10px; }
    .actions button {
      flex: 1; padding: 6px 0; border-radius: 8px; border: 1px solid #e0dcec; background: #faf9fd;
      cursor: pointer; font: inherit; color: inherit;
    }
    .actions button:hover { border-color: var(--c); color: var(--c); }
    button.icon { border: 0; background: transparent; cursor: pointer; font-size: 16px; padding: 2px 4px; border-radius: 6px; color: #6b6880; }
    button.icon:hover { background: #f0eef6; }
    .star.on { color: #f5a524; }
    .loading, .err { padding: 4px 0; color: #6b6880; }
    .err { color: #c0392b; }
    .sel-icon {
      position: fixed; width: 28px; height: 28px; border-radius: 8px; border: 0; cursor: pointer;
      background: var(--c); color: #fff; font-weight: 700; box-shadow: 0 4px 12px rgba(0,0,0,.2);
    }
    .toast {
      position: fixed; right: 20px; bottom: 20px; max-width: 360px; padding: 10px 14px; border-radius: 10px;
      background: #1f1f29; color: #fff; box-shadow: 0 8px 24px rgba(0,0,0,.25);
    }
    @media (prefers-color-scheme: dark) {
      .card { background: #1f1e27; color: #ecebf3; border-color: #34323f; }
      .phon, .pos, .muted, .loading { color: #a3a0b5; }
      .note { color: #c9c6d8; }
      .ex { background: #2a2934; }
      .tag { background: #2f2d3a; color: #c9c6d8; }
      .tag.learn { background: color-mix(in srgb, var(--c) 30%, #1f1e27); color: #e6dcff; }
      .tag.ok { background: #1d3a2a; color: #8fe0b0; }
      .actions button { background: #272631; border-color: #3a3846; }
      button.icon:hover { background: #2f2d3a; }
    }
  `;

  init();
})();
