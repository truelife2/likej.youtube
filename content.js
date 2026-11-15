// content.js — 在 YouTube 頁面上顯示翻譯字幕
// 用 Shadow DOM 隔離樣式，避免被 YouTube 的 CSS 干擾。

(() => {
  // 重新注入（例如擴充功能重新載入、手動 reload）時，舊的實例已經失效，
  // 但它留下的字幕框還在畫面上，看起來像「連著卻沒有字幕」→ 先讓它停手並清掉。
  // 注意不能靠 window.__ytltInjected 提早 return：舊實例的訊息管道已死，
  // 提早 return 會讓頁面永遠收不到新的字幕事件。
  if (typeof window.__ytltDestroy === 'function') {
    try {
      window.__ytltDestroy();
    } catch (_) {}
  }
  let alive = true;
  window.__ytltDestroy = () => {
    alive = false;
    try {
      const el = document.getElementById('ytlt-host');
      if (el) el.remove();
    } catch (_) {}
  };
  window.__ytltInjected = true;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }

    .box {
      position: fixed;
      left: 50%;
      bottom: 12%;
      transform: translateX(-50%);
      z-index: 2147483000;
      width: max-content;
      min-width: 340px;
      max-width: min(940px, 90vw);
      padding: 10px 16px 12px;
      border-radius: 14px;
      background: rgba(10, 10, 14, 0.82);
      -webkit-backdrop-filter: blur(8px);
      backdrop-filter: blur(8px);
      color: #fff;
      font-family: "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
      cursor: grab;
      user-select: none;
      transition: opacity 0.3s ease;

      /* 邊框用顏色標示連線狀態 */
      outline: 1px solid rgba(255, 255, 255, 0.08);
    }
    .box.dragging { cursor: grabbing; }
    .box.faded { opacity: 0.35; }
    .box.hidden { display: none; }
    .box.err { outline-color: rgba(255, 90, 90, 0.55); }

    .src {
      font-size: 0.72em;
      line-height: 1.35;
      color: rgba(255, 255, 255, 0.55);
      min-height: 1.2em;
      word-break: break-word;
    }
    .src:empty { display: none; }

    .dst {
      font-size: 1em;
      line-height: 1.4;
      font-weight: 600;
      margin-top: 2px;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
      word-break: break-word;
      white-space: pre-line;
      min-height: 1.4em;
    }
    .dst:empty::before {
      content: "翻譯中…";
      font-weight: 400;
      color: rgba(255, 255, 255, 0.35);
    }
    /* 本機模式每句輪替顏色，看不出新句從哪開始 */
    .dst .alt { color: #7fd0ff; }

    .notice {
      margin-top: 6px;
      font-size: 0.7em;
      line-height: 1.4;
      color: #ff9b9b;
      word-break: break-word;
    }
    .notice:empty { display: none; }
    .notice.info { color: #f5c542; }

    .lat {
      margin-top: 4px;
      font-size: 0.6em;
      color: rgba(255, 255, 255, 0.3);
      letter-spacing: 0.03em;
    }
    .lat:empty { display: none; }

    .tools {
      position: absolute;
      top: 4px;
      right: 6px;
      display: flex;
      gap: 2px;
      opacity: 0;
      transition: opacity 0.15s ease;
    }
    .box:hover .tools { opacity: 1; }

    .tools button {
      all: unset;
      cursor: pointer;
      font: 600 11px/1 system-ui, sans-serif;
      color: rgba(255, 255, 255, 0.65);
      padding: 4px 6px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.08);
    }
    .tools button:hover { background: rgba(255, 255, 255, 0.2); color: #fff; }

    .dot {
      position: absolute;
      top: 8px;
      left: 6px;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #8a8a8a;
    }
    .dot.connecting { background: #f5c542; animation: yl-pulse 1.1s infinite; }
    .dot.connected { background: #3ddc84; }
    .dot.listening { background: #4aa8ff; box-shadow: 0 0 0 2px rgba(74, 168, 255, 0.25); }
    .dot.reconnecting { background: #f5c542; animation: yl-pulse 1.1s infinite; }
    .dot.error { background: #ff5a5a; }

    @keyframes yl-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.25; } }
  `;

  const MARKUP = `
    <div class="box hidden" id="box">
      <span class="dot" id="dot"></span>
      <div class="src" id="src"></div>
      <div class="dst" id="dst"></div>
      <div class="notice" id="notice"></div>
      <div class="lat" id="lat"></div>
      <div class="tools">
        <button data-act="smaller" title="縮小字幕">A-</button>
        <button data-act="bigger" title="放大字幕">A+</button>
        <button data-act="stop" title="停止翻譯">&#10005;</button>
      </div>
    </div>
  `;

  let host = null;
  let box = null;
  let els = null;

  let fontSize = 26;
  let pos = null; // { x, y } 左上角像素座標，null = 預設位置
  let showSource = true;

  const rows = {
    input: { el: null, text: '', at: 0 },
    // 譯文以「段」保存（parts），每段可有自己的顏色：本機模式每句換色，才看得出新句從哪開始
    output: { el: null, text: '', at: 0, parts: [] },
  };

  let fadeTimer = null;
  let outTurnDone = false;
  let outAlt = false;
  // 即時翻譯模型是連續串流：字幕不要每到一段就清空，改用句子邊界往上捲
  let continuous = false;
  let appendTurns = false;
  let latMs = 0;
  let rateX = 1;
  let behindSec = 0;
  let backlogSec = 0;
  let autoPause = true;
  let warnedAutoOff = 0;
  let pauseAfterSec = 45;
  let resumeSec = 10;
  let pausedByUs = false;
  let lastPauseAt = 0;
  let lastIdleWarn = 0;
  let lastQuietWarn = 0;
  let levelPct = 0;
  let speedFixed = false;
  let lastSilenceWarn = 0;
  let lastOutputAt = 0;
  let listening = false;
  let lastStatus = 'idle';
  let renderScheduled = false;

  /* ---------------------------------------------------------------- */
  /* 建立 UI                                                          */
  /* ---------------------------------------------------------------- */

  function ensureUI() {
    if (host && host.isConnected) return;

    host = document.createElement('div');
    host.id = 'ytlt-host';
    host.style.all = 'initial';
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    const wrap = document.createElement('div');
    wrap.innerHTML = MARKUP;
    root.appendChild(wrap);

    box = root.getElementById('box');
    els = {
      src: root.getElementById('src'),
      dst: root.getElementById('dst'),
      notice: root.getElementById('notice'),
      lat: root.getElementById('lat'),
      dot: root.getElementById('dot'),
    };
    rows.input.el = els.src;
    rows.output.el = els.dst;

    attachMount();
    applyFontSize();
    applyPosition();

    if (showSource) els.src.style.display = '';
    else els.src.style.display = 'none';

    bindUI();
    document.addEventListener('fullscreenchange', attachMount, true);
  }

  function attachMount() {
    const fs = document.fullscreenElement;
    const target = fs || document.body;
    if (host && target && host.parentNode !== target) {
      target.appendChild(host);
    }
  }

  function applyFontSize() {
    if (!box) return;
    const scale = fontSize / 26;
    box.style.fontSize = fontSize + 'px';
    els.src.style.fontSize = Math.max(11, Math.round(fontSize * 0.58)) + 'px';
    box.style.maxWidth = 'min(' + Math.round(940 * Math.max(1, scale)) + 'px, 90vw)';
  }

  function applyPosition() {
    if (!box) return;
    if (pos) {
      box.style.left = pos.x + 'px';
      box.style.top = pos.y + 'px';
      box.style.bottom = 'auto';
      box.style.transform = 'none';
    } else {
      box.style.left = '50%';
      box.style.top = 'auto';
      box.style.bottom = '12%';
      box.style.transform = 'translateX(-50%)';
    }
  }

  function bindUI() {
    // 拖曳
    let dragState = null;

    box.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.tools')) return;
      const rect = box.getBoundingClientRect();
      dragState = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      box.classList.add('dragging');
      box.setPointerCapture(e.pointerId);
    });

    box.addEventListener('pointermove', (e) => {
      if (!dragState) return;
      const w = box.offsetWidth;
      const h = box.offsetHeight;
      const x = Math.min(Math.max(0, e.clientX - dragState.dx), window.innerWidth - w);
      const y = Math.min(Math.max(0, e.clientY - dragState.dy), window.innerHeight - h);
      pos = { x: Math.round(x), y: Math.round(y) };
      applyPosition();
    });

    box.addEventListener('pointerup', (e) => {
      if (!dragState) return;
      dragState = null;
      box.classList.remove('dragging');
      try {
        box.releasePointerCapture(e.pointerId);
      } catch (_) {}
      chrome.storage.local.set({ overlayPos: pos }).catch(() => {});
    });

    // 按鈕
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'bigger') fontSize = Math.min(52, fontSize + 3);
      else if (act === 'smaller') fontSize = Math.max(14, fontSize - 3);
      else if (act === 'stop') {
        chrome.runtime.sendMessage({ target: 'background', type: 'STOP' }).catch(() => {});
        hideBox();
        return;
      }
      applyFontSize();
      chrome.storage.local.set({ subtitleSize: fontSize }).catch(() => {});
    });

    window.addEventListener('resize', () => {
      if (!pos) return;
      pos.x = Math.min(pos.x, Math.max(0, window.innerWidth - box.offsetWidth));
      pos.y = Math.min(pos.y, Math.max(0, window.innerHeight - box.offsetHeight));
      applyPosition();
    });
  }

  /* ---------------------------------------------------------------- */
  /* 顯示邏輯                                                          */
  /* ---------------------------------------------------------------- */

  function hideBox() {
    if (box) box.classList.add('hidden');
    resetRows();
    latMs = 0;
    rateX = 1;
    levelPct = 0;
    lastStatus = 'idle';
    listening = false;
    applyDot();
  }

  function renderLat() {
    if (!els || !els.lat) return;
    const parts = [];
    if (latMs > 0) parts.push('延遲 ' + (latMs / 1000).toFixed(1) + 's');
    if (backlogSec >= 5) parts.push('待譯 ' + backlogSec.toFixed(0) + 's');
    else if (behindSec >= 5) parts.push('落後 ' + behindSec.toFixed(0) + 's');
    if (Math.abs(rateX - 1) >= 0.05) parts.push('送稿 x' + rateX.toFixed(2));
    if (levelPct > 0 && levelPct < 30) parts.push('峰值 ' + levelPct + '%');
    els.lat.textContent = parts.join('・');
  }

  // 「積太多就暫停影片、等它翻完再繼續」：暫停後輸入停止，模型會把已收到的音訊翻完
  function applyCatchup() {
    if (lastStatus === 'idle') return;
    const v = video();
    if (!v) return;
    if (pausedByUs && !v.paused) pausedByUs = false; // 使用者自己按了播放

    // 兩種落後都要看：待譯（送進去還沒翻）+ 落後（已產出譯音少於已送出音訊）。
    // 對話模型（2.5 / 3.8）的口譯不是逐塊對應，待譯可能一直是 0，只有落後會長大。
    const lagSec = Math.max(backlogSec, behindSec);

    if (!pausedByUs) {
      if (lagSec <= pauseAfterSec) return;
      if (!autoPause) {
        // 已超過門檻卻沒開自動暫停：明確講一次，否則看起來就像「一直跳過」
        if (Date.now() - warnedAutoOff > 60000) {
          warnedAutoOff = Date.now();
          showNotice(
            '落後 ' + lagSec.toFixed(0) + ' 秒，但「自動暫停影片」是關閉的。要它停下來等，請到 popup 勾選。',
            'info'
          );
        }
        return;
      }
      if (v.paused) return;
      lastPauseAt = Date.now();
      try {
        v.pause();
      } catch (_) {
        return;
      }
      pausedByUs = true;
      showNotice('已落後 ' + lagSec.toFixed(0) + ' 秒，先暫停等它翻完…', 'info');
      return;
    }

    const waited = Date.now() - lastPauseAt;
    const stuck = waited > Math.max(30000, resumeSec * 3000);
    if (lagSec <= resumeSec || stuck) {
      pausedByUs = false;
      if (v.paused) v.play().catch(() => {});
      showNotice(lagSec <= resumeSec ? '' : '先恢復播放（模型仍在追）', lagSec <= resumeSec ? '' : 'info');
    }
  }

  /* ---------------------------------------------------------------- */
  /* 影片元素（自動暫停用）                                             */
  /* ---------------------------------------------------------------- */

  // YouTube 頁面上可能同時有多個 <video>（廣告、預覽），主播放器有這個 class
  function video() {
    return document.querySelector('video.html5-main-video') || document.querySelector('video');
  }

  function touch() {
    if (!box) return;
    box.classList.remove('faded');
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      // 出錯時不要把錯誤訊息淡掉，否則看起來像卡住
      if (box && lastStatus !== 'error') box.classList.add('faded');
    }, 9000);
  }

  function resetRows() {
    rows.input.text = '';
    rows.output.text = '';
    rows.output.parts = [];
    outAlt = false;
    if (els) {
      els.src.textContent = '';
      els.dst.textContent = '';
      els.dstKey = '';
    }
  }

  // 譯文追加：同顏色的連續片段合併成一段，避免每個 delta 都產生一個 span
  function outAppend(text, alt) {
    if (!text) return;
    const parts = rows.output.parts;
    const last = parts[parts.length - 1];
    if (last && last.alt === !!alt) last.t += text;
    else parts.push({ t: text, alt: !!alt });
    rows.output.text = parts.map((p) => p.t).join('').replace(/^\s+/, '');
    trimOutput();
    scheduleRender();
  }

  function outClear() {
    rows.output.parts = [];
    rows.output.text = '';
  }

  function trimOutput() {
    const LIMIT = 400;
    if (rows.output.text.length <= LIMIT) return;
    let over = rows.output.text.length - LIMIT;
    const parts = rows.output.parts;
    while (over > 0 && parts.length) {
      const p = parts[0];
      if (p.t.length <= over) {
        over -= p.t.length;
        parts.shift();
      } else {
        p.t = p.t.slice(over);
        over = 0;
      }
    }
    rows.output.text = parts.map((p) => p.t).join('');
  }

  function pushText(row, delta, gapMs) {
    if (!row.el) return;
    const now = performance.now();
    const gap = typeof gapMs === 'number' ? gapMs : 2000;
    // 停頓太久就視為新的一句，避免字幕無限累積
    if (row.text && now - row.at > gap) row.text = '';
    row.at = now;

    row.text = (row.text + delta).replace(/^\s+/, '');
    const LIMIT = 260;
    if (row.text.length > LIMIT) row.text = '…' + row.text.slice(-LIMIT);
    scheduleRender();
  }

  // 模型可能每秒吐十幾個片段：只在每個畫格寫一次 DOM，避免反覆排版
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    const flush = () => {
      renderScheduled = false;
      if (!els) return;
      if (els.src.textContent !== rows.input.text) els.src.textContent = rows.input.text;
      // 譯文用 span 分段上色，靠 key 比對決定要不要重建
      const key = rows.output.parts.map((p) => (p.alt ? '1' : '0') + p.t).join('\u0001');
      if (els.dstKey !== key) {
        els.dstKey = key;
        els.dst.textContent = '';
        for (const p of rows.output.parts) {
          if (!p.t) continue;
          if (p.alt) {
            const s = document.createElement('span');
            s.className = 'alt';
            s.textContent = p.t;
            els.dst.appendChild(s);
          } else {
            els.dst.appendChild(document.createTextNode(p.t));
          }
        }
      }
      touch();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else flush();
  }

  // 字幕累積太長就沿句子邊界往上捲，保留最近一兩句
  function rollOutput() {
    const text = rows.output.text;
    if (text.length <= 120) return;
    const keep = 90; // 至少留這麼多字，不要切在半句中間
    const marks = ['\n', '。', '！', '？', '；', '! ', '? ', '. '];
    let cut = -1;
    for (const m of marks) {
      const i = text.lastIndexOf(m, text.length - keep);
      if (i > cut) cut = i + m.length;
    }
    if (cut <= 0) cut = Math.max(0, text.length - 120);

    let over = cut;
    const parts = rows.output.parts;
    while (over > 0 && parts.length) {
      const p = parts[0];
      if (p.t.length <= over) {
        over -= p.t.length;
        parts.shift();
      } else {
        p.t = p.t.slice(over);
        over = 0;
      }
    }
    if (parts.length) parts[0].t = parts[0].t.replace(/^[\s\n]+/, '');
    rows.output.text = parts.map((p) => p.t).join('');
    scheduleRender();
  }

  function applyDot() {
    if (!els) return;
    let cls = 'dot';
    if (lastStatus && lastStatus !== 'idle') cls += ' ' + lastStatus;
    if (listening && lastStatus === 'connected') cls += ' listening';
    els.dot.className = cls;
    if (box) box.classList.toggle('err', lastStatus === 'error');
  }

  function showNotice(text, kind) {
    ensureUI();
    box.classList.remove('hidden');
    els.notice.className = 'notice' + (kind === 'info' ? ' info' : '');
    els.notice.textContent = text || '';
    touch();
    if (text) {
      clearTimeout(showNotice._t);
      showNotice._t = setTimeout(() => {
        if (els) els.notice.textContent = '';
      }, 10000);
    }
  }

  /* ---------------------------------------------------------------- */
  /* 事件                                                             */
  /* ---------------------------------------------------------------- */

  function handleEvent(ev) {
    if (!alive || !ev) return;
    switch (ev.kind) {
      case 'config': {
        const c = ev.config || {};
        if (typeof c.showSource === 'boolean') showSource = c.showSource;
        if (typeof c.subtitleSize === 'number') fontSize = c.subtitleSize;
        if (typeof c.autoPause === 'boolean') autoPause = c.autoPause;
        if (Number(c.pauseAfterSec) > 0) pauseAfterSec = Number(c.pauseAfterSec);
        if (Number(c.resumeSec) >= 0) resumeSec = Number(c.resumeSec);
        if (c.model || c.engine) {
          // 兩種引擎都把譯文累積起來（每句接在後面、顏色交替），不要一句一句蓋掉
          appendTurns = true;
          continuous =
            c.engine === 'local' || /live-translate|translate-live/i.test(String(c.model || ''));
          speedFixed = false;
        }
        ensureUI();
        els.src.style.display = showSource ? '' : 'none';
        applyFontSize();
        applyPosition();
        box.classList.remove('hidden');
        els.notice.textContent = '';
        lastOutputAt = Date.now();
        touch();
        break;
      }
      case 'input':
        ensureUI();
        if (!showSource) return;
        pushText(rows.input, ev.delta, 2000);
        break;
      case 'output': {
        ensureUI();
        lastOutputAt = Date.now();
        const delta = ev.delta || '';
        // 換色規則：能辨識回合（有 turn 事件）就每回合換色；
        // 連續串流模型不送 turn，就改用「句尾標點」當分段點，一樣是白／淺藍輪替。
        if (outTurnDone) {
          if (appendTurns) {
            if (rows.output.text) outAlt = !outAlt;
          } else if (!continuous) {
            outClear();
          }
          outTurnDone = false;
        } else if (appendTurns && rows.output.text && /[。！？!?]\s*$/.test(rows.output.text)) {
          outAlt = !outAlt;
        }
        outAppend(delta, appendTurns && outAlt);
        rollOutput();
        // 譯文回來了就代表管線正常，把先前「沒有逐字稿」這類提示清掉
        if (els.notice && els.notice.textContent) showNotice('');
        break;
      }
      case 'turn':
        outTurnDone = true;
        touch();
        break;
      case 'speech':
        ensureUI();
        if (ev.on) {
          rows.input.text = '';
          if (els) els.src.textContent = '';
        }
        listening = !!ev.on;
        applyDot();
        break;
      case 'status':
        ensureUI();
        lastStatus = ev.status || 'connected';
        applyDot();
        if (ev.detail) showNotice('');
        touch();
        break;
      case 'latency':
        ensureUI();
        latMs = Number(ev.ms) || 0;
        renderLat();
        touch();
        break;
      case 'stats': {
        ensureUI();
        rateX = Number(ev.rateX) || 1;
        behindSec = Number(ev.behind) || 0;
        backlogSec = Number(ev.backlog) || 0;
        levelPct = Number(ev.level) || 0;
        renderLat();
        const v = video();
        // 倍速播放不會改變取樣率，但會讓模型每秒收到 2 倍的「內容」，
        // 它講得再快也追不上 → 落後時直接把速度調回 1x（並告知）
        if (v && v.playbackRate > 1.05 && behindSec > 5 && !speedFixed) {
          const prev = v.playbackRate;
          v.playbackRate = 1;
          speedFixed = true;
          showNotice('播放速度 ' + prev + 'x 會讓翻譯越追越慢，已調回 1x。', 'info');
        }
        if (rateX > 1.3 && behindSec > 4) {
          showNotice(
            '送進模型的音訊是即時的 ' + rateX.toFixed(2) + ' 倍（可能重複擷取），請按停止再開始。',
            'info'
          );
        }
        // 播放在跑卻收不到音訊：擷取管線掛了，只能重開
        if (ev.idle > 6 && v && !v.paused && Date.now() - lastIdleWarn > 15000) {
          lastIdleWarn = Date.now();
          showNotice('收不到分頁音訊，請按停止再重新開始。');
        }
        // 有在播但幾乎沒音量：分頁靜音或系統音量太小，VAD 抓不到人聲
        // 峰值 < 3% 才真的是沒聲音（講話時峰值通常 30–90%）
        if (ev.idle <= 6 && levelPct < 3 && v && !v.paused && Date.now() - lastQuietWarn > 30000) {
          lastQuietWarn = Date.now();
          showNotice('幾乎收不到聲音（峰值 ' + levelPct + '%），檢查分頁是否靜音或系統音量。', 'info');
        }
        // 配額等待中不算卡住；也要真的有待譯內容才提醒
        if (
          !ev.quota &&
          lastStatus === 'connected' &&
          ev.idle <= 6 &&
          backlogSec > 2 &&
          lastOutputAt &&
          Date.now() - lastOutputAt > 20000 &&
          Date.now() - lastSilenceWarn > 20000
        ) {
          lastSilenceWarn = Date.now();
          showNotice('有 ' + backlogSec.toFixed(0) + ' 秒語音還沒翻出來，請按停止再重新開始。', 'info');
        }
        applyCatchup();
        break;
      }
      case 'note':
        showNotice(ev.message || '', 'info');
        break;
      case 'error':
        showNotice(ev.message || '發生錯誤');
        lastStatus = 'error';
        applyDot();
        break;
      case 'stopped':
        hideBox();
        break;
      default:
        break;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === 'YTLT_PING') {
      let v = '';
      try {
        v = chrome.runtime.getManifest().version || '';
      } catch (_) {}
      sendResponse({ ok: true, v });
      return false;
    }
    if (msg.type === 'YTLT') {
      handleEvent(msg.event);
    }
    return false;
  });

  // YouTube 換影片不會重新載入頁面，字幕框要跟著清空，否則會留著上一部影片的字
  document.addEventListener('yt-navigate-finish', () => {
    if (location.pathname !== '/watch') {
      // 離開影片頁（首頁、頻道、搜尋、Shorts…）就停止擷取，不要繼續翻別的頁面
      chrome.runtime.sendMessage({ target: 'background', type: 'YT_GONE' }).catch(() => {});
      return;
    }
    if (!box) return;
    resetRows();
    lastOutputAt = Date.now();
    latMs = 0;
    behindSec = 0;
    backlogSec = 0;
    pausedByUs = false;
    renderLat();
    touch();
  });

  // 整頁離開（換站、關分頁、重新整理）也通知 background 收工
  window.addEventListener('pagehide', () => {
    chrome.runtime.sendMessage({ target: 'background', type: 'YT_GONE' }).catch(() => {});
  });

  // 影片恢復播放時叫醒音訊管線：暫停久了瀏覽器可能把 AudioContext 或連線擱置，
  // 不叫醒會出現「暫停後再播就不翻譯」的現象。
  let lastWakeAt = 0;
  document.addEventListener(
    'play',
    () => {
      const now = Date.now();
      if (now - lastWakeAt < 3000) return;
      lastWakeAt = now;
      chrome.runtime.sendMessage({ target: 'background', type: 'WAKE' }).catch(() => {});
    },
    true
  );

  /* ---------------------------------------------------------------- */
  /* 初始化：讀回使用者偏好                                            */
  /* ---------------------------------------------------------------- */

  chrome.storage.local
    .get(['subtitleSize', 'overlayPos'])
    .then((res) => {
      if (typeof res.subtitleSize === 'number') fontSize = res.subtitleSize;
      if (res.overlayPos && typeof res.overlayPos.x === 'number') pos = res.overlayPos;
      if (box) {
        applyFontSize();
        applyPosition();
      }
    })
    .catch(() => {});
})();
