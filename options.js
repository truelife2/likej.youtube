const $ = (id) => document.getElementById(id);

function host(cmd, payload, timeout) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ target: 'background', type: 'HOST', cmd, payload, timeout }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(res || { ok: false, error: '沒有回應' });
    });
  });
}

function setStatus(text, kind) {
  const dot = $('dot');
  if (dot) dot.className = 'dot ' + (kind || '');
  const el = $('statusText');
  if (el) el.textContent = text;
}

function hint(text) {
  const el = $('hostHint');
  if (el) el.textContent = text || '';
}

async function refreshStatus() {
  setStatus('檢查中…', 'wait');
  const st = await host('status', {}, 8000);
  if (!st || st.ok === false) {
    setStatus('無法連上原生主機', 'bad');
    hint(
      st && st.disconnect
        ? '原生主機沒有啟動。執行一次 native-host\\install.cmd 就會安裝好（需要 csc.exe）。'
        : (st && st.error) || '請先安裝原生主機：native-host\\install.cmd'
    );
    return;
  }
  if (st.running) {
    const info = st.info || {};
    const dev = info.device === 'cuda' ? 'GPU' : String(info.device || 'CPU');
    const name = String(info.modelName || info.model || '').split(/[\\/]/).pop();
    setStatus('服務執行中（' + dev + (name ? '・' + name : '') + '）', 'ok');
    hint('http://127.0.0.1:' + ((st.config && st.config.port) || 8791) + ' 正常回應。');
  } else {
    setStatus('服務沒有在執行', 'bad');
    hint('按「啟動服務」，或在 YouTube 頁按「開始」時自動啟動。');
  }
}

function fillModels(models, current) {
  const sel = $('model');
  if (!sel) return;
  sel.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = '（自動：伺服器啟動時的模型）';
  sel.appendChild(auto);
  for (const m of models || []) {
    const o = document.createElement('option');
    o.value = m.path;
    o.textContent = m.name + (m.mb ? '（' + m.mb + ' MB）' : '');
    sel.appendChild(o);
  }
  const want = current || '';
  if (want) {
    const has = Array.from(sel.options).some((o) => o.value === want);
    if (!has) {
      const o = document.createElement('option');
      o.value = want;
      o.textContent = String(want).split(/[\\/]/).pop() + '（目前設定）';
      sel.appendChild(o);
    }
    sel.value = want;
  }
}

async function load() {
  try {
    $('extId').textContent = chrome.runtime.id;
  } catch (_) {}
  const cfg = await host('get-config', {}, 8000);
  if (!cfg || cfg.ok === false) {
    hint('讀不到設定（' + ((cfg && cfg.error) || '原生主機未安裝') + '）。');
    return;
  }
  const c = cfg.config || {};
  $('python').value = c.python || '';
  $('modelsRoot').value = c.modelsRoot || '';
  $('port').value = String(c.port || 8791);
  $('autostart').checked = !!c.autostart;
  $('model').dataset.current = c.model || '';
  await scan();
  await refreshStatus();
}

async function scan() {
  const root = $('modelsRoot').value.trim();
  const res = await host('list-models', {}, 15000);
  if (!res || res.ok === false) {
    $('model').innerHTML = '';
    fillModels([], $('model').dataset.current || '');
    return;
  }
  if (root && res.root && root !== res.root) {
    // 使用者改了路徑但還沒存：先存起來再掃描
    await host('set-config', { config: { modelsRoot: root } }, 8000);
  }
  fillModels(res.models || [], $('model').dataset.current || '');
}

async function save() {
  const cfg = {
    python: $('python').value.trim(),
    modelsRoot: $('modelsRoot').value.trim(),
    port: Number($('port').value) || 8791,
    model: $('model').value || '',
    autostart: $('autostart').checked,
  };
  const res = await host('set-config', { config: cfg }, 10000);
  const msg = $('saveMsg');
  if (!res || res.ok === false) {
    if (msg) msg.textContent = '儲存失敗：' + ((res && res.error) || '未知錯誤');
    return;
  }
  if (msg) msg.textContent = '已儲存。';
  $('model').dataset.current = cfg.model;
  const auto = await host('autostart', { on: cfg.autostart }, 20000);
  if (msg && auto && auto.ok === false) msg.textContent = '設定已存，但開機啟動設定失敗：' + auto.error;
  await refreshStatus();
  setTimeout(() => {
    if (msg) msg.textContent = '';
  }, 4000);
}

function nativeReady() {
  try {
    if (typeof chrome.runtime.connectNative !== 'function') return false;
    const perms = chrome.runtime.getManifest().permissions || [];
    return perms.indexOf('nativeMessaging') >= 0;
  } catch (_) {
    return false;
  }
}

// 這一頁是從磁碟讀新檔，但「權限」只會在擴充功能重新載入時生效。
// 所以可能出現頁面是新的、背景還是舊的情形 → 直接告訴使用者按一下重載。
function showReloadNeeded() {
  const btn = $('btnReloadExt');
  if (btn) btn.style.display = '';
  $('btnStart').disabled = true;
  $('btnStop').disabled = true;
  setStatus('擴充功能需要重新載入（原生主機權限尚未生效）', 'bad');
  hint('頁面是新的，但瀏覽器還跑著沒有 nativeMessaging 權限的舊版。按「重新載入擴充功能」，再回來按「啟動服務」。');
}

document.addEventListener('DOMContentLoaded', () => {
  $('btnRefresh').addEventListener('click', refreshStatus);
  $('btnScan').addEventListener('click', scan);
  $('btnSave').addEventListener('click', save);

  const reloadBtn = $('btnReloadExt');
  if (reloadBtn) {
    reloadBtn.addEventListener('click', () => {
      setStatus('重新載入中…請稍等，然後回上一頁再按啟動', 'wait');
      try {
        chrome.runtime.reload();
      } catch (_) {
        setStatus('請自行到 chrome://extensions 按重新載入', 'bad');
      }
    });
  }

  if (!nativeReady()) {
    showReloadNeeded();
    return;
  }

  $('btnDetect').addEventListener('click', async () => {
    const res = await host('detect-python', {}, 10000);
    if (!res || res.ok === false) return;
    const list = res.python || [];
    if (list.length) {
      $('python').value = list[0];
      const msg = $('saveMsg');
      if (msg) {
        msg.textContent =
          '找到 ' + list.length + ' 個：' + list.slice(0, 3).join('  |  ') + '。按「儲存設定」套用。';
      }
    }
  });

  $('btnStart').addEventListener('click', async () => {
    setStatus('啟動中…（第一次載入模型約 2–6 秒）', 'wait');
    const res = await host('start', {}, 90000);
    if (!res || res.ok === false) {
      setStatus('啟動失敗', 'bad');
      hint((res && res.error) || '請看 .logs\\asr.log');
      return;
    }
    await refreshStatus();
  });

  $('btnStop').addEventListener('click', async () => {
    setStatus('停止中…', 'wait');
    await host('stop', {}, 20000);
    await refreshStatus();
  });

  $('model').addEventListener('change', () => {
    $('model').dataset.current = $('model').value;
  });

  load();
});
