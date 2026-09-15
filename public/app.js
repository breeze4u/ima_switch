const $ = (sel) => document.querySelector(sel);

let health = { imaRunning: false, imaFound: false };
let pendingExportId = null;
let pendingImportFile = null;
let pendingSwitchId = null;

function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  el.classList.toggle('err', isErr);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 3500);
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('application/json')) {
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error?.message || res.statusText);
    return body;
  }
  if (!res.ok) throw new Error(res.statusText || 'request failed');
  return res;
}

async function loadHealth() {
  health = await api('/api/health');
  $('#imaPath').textContent = health.imaUserData || '-';
  $('#vaultPath').textContent = health.vaultRoot || '-';
  const dot = $('#runDot');
  const text = $('#runText');
  if (health.imaRunning) {
    dot.className = 'dot on';
    text.textContent = 'IMA 运行中';
  } else {
    dot.className = 'dot off';
    text.textContent = health.imaFound ? 'IMA 未运行' : '未找到 IMA';
  }
}

function initials(name) {
  const s = String(name || '?').trim();
  return s.slice(0, 1).toUpperCase();
}

function renderAccounts(accounts) {
  const box = $('#accounts');
  box.innerHTML = '';
  $('#empty').hidden = accounts.length > 0;
  for (const a of accounts) {
    const card = document.createElement('article');
    card.className = 'card';
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    if (a.avatarUrl) {
      const img = document.createElement('img');
      img.src = a.avatarUrl;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      avatar.appendChild(img);
    } else {
      avatar.textContent = initials(a.nickname || a.name);
    }
    const mid = document.createElement('div');
    mid.innerHTML = `
      <div class="name">${escapeHtml(a.name)}${a.nickname ? ` <span style="color:var(--muted);font-weight:400;font-size:13px">· ${escapeHtml(a.nickname)}</span>` : ''}</div>
      <div class="desc">
        ID <code>${escapeHtml(a.id)}</code>
        ${a.userId ? ` · uid <code>${escapeHtml(a.userId)}</code>` : ''}
        ${a.updatedAt ? ` · 更新 ${escapeHtml(a.updatedAt)}` : ''}
        ${a.lastUsedAt ? ` · 上次使用 ${escapeHtml(a.lastUsedAt)}` : ''}
        ${a.note ? `<br/>${escapeHtml(a.note)}` : ''}
      </div>`;
    const ops = document.createElement('div');
    ops.className = 'ops';
    ops.innerHTML = `
      <button class="btn primary" data-act="switch">切换</button>
      <button class="btn" data-act="resave">覆盖保存</button>
      <button class="btn" data-act="export">导出</button>
      <button class="btn danger" data-act="delete">删除</button>
    `;
    ops.querySelector('[data-act="switch"]').onclick = () => openSwitch(a);
    ops.querySelector('[data-act="resave"]').onclick = async () => {
      if (!confirm(`用当前 IMA 登录状态覆盖「${a.name}」？`)) return;
      try {
        await api(`/api/accounts/${encodeURIComponent(a.id)}/resave`, { method: 'POST' });
        toast('已覆盖保存');
        await refresh();
      } catch (e) {
        toast(e.message, true);
      }
    };
    ops.querySelector('[data-act="export"]').onclick = () => openExport(a);
    ops.querySelector('[data-act="delete"]').onclick = async () => {
      if (!confirm(`删除账号「${a.name}」？此操作不可恢复。`)) return;
      try {
        await api(`/api/accounts/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
        toast('已删除');
        await refresh();
      } catch (e) {
        toast(e.message, true);
      }
    };
    card.append(avatar, mid, ops);
    box.appendChild(card);
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function refresh() {
  await loadHealth();
  const { accounts } = await api('/api/accounts');
  renderAccounts(accounts);
}

function openSwitch(account) {
  pendingSwitchId = account.id;
  $('#switchMsg').textContent = `将切换到「${account.name}」${
    account.nickname ? `（${account.nickname}）` : ''
  }。当前登录状态会先备份。`;
  $('#dlgSwitch').showModal();
}

function openExport(account) {
  pendingExportId = account.id;
  $('#exportMsg').textContent = `导出「${account.name}」的登录态快照。`;
  $('#dlgExport').showModal();
}

$('#btnRefresh').onclick = () => refresh().catch((e) => toast(e.message, true));

$('#btnSave').onclick = () => {
  $('#saveForm').name.value = '';
  $('#saveForm').note.value = '';
  $('#dlgSave').showModal();
};

$('#saveForm').addEventListener('submit', async (ev) => {
  // method=dialog: ok button value ok
  // handle after close
});

$('#dlgSave').addEventListener('close', async () => {
  if ($('#dlgSave').returnValue !== 'ok') return;
  const form = $('#saveForm');
  const name = form.name.value.trim();
  if (!name) return;
  try {
    await api('/api/accounts/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, note: form.note.value }),
    });
    toast('已保存当前账号');
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
});

$('#dlgSwitch').addEventListener('close', async () => {
  if ($('#dlgSwitch').returnValue !== 'ok' || !pendingSwitchId) return;
  const launch = $('#switchForm').launch.checked;
  try {
    await api(`/api/accounts/${encodeURIComponent(pendingSwitchId)}/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmProcess: true, launch }),
    });
    toast('切换完成');
    await refresh();
  } catch (e) {
    toast(e.message, true);
  } finally {
    pendingSwitchId = null;
  }
});

$('#dlgExport').addEventListener('close', async () => {
  if ($('#dlgExport').returnValue !== 'ok' || !pendingExportId) return;
  const password = $('#exportForm').password.value;
  try {
    const res = await fetch(`/api/accounts/${encodeURIComponent(pendingExportId)}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password || undefined }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error?.message || res.statusText);
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = /filename="([^"]+)"/.exec(cd);
    const filename = m ? m[1] : 'ima-account.zip';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    toast('已开始下载导出包');
  } catch (e) {
    toast(e.message, true);
  } finally {
    pendingExportId = null;
    $('#exportForm').password.value = '';
  }
});

$('#btnImport').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = () => {
  pendingImportFile = $('#fileInput').files?.[0] || null;
  if (!pendingImportFile) return;
  $('#importFileLabel').textContent = `已选择：${pendingImportFile.name}`;
  $('#dlgImport').showModal();
};

$('#dlgImport').addEventListener('close', async () => {
  if ($('#dlgImport').returnValue !== 'ok' || !pendingImportFile) return;
  const form = $('#importForm');
  const fd = new FormData();
  fd.append('file', pendingImportFile);
  if (form.password.value) fd.append('password', form.password.value);
  if (form.name.value.trim()) fd.append('name', form.name.value.trim());
  try {
    await api('/api/accounts/import', { method: 'POST', body: fd });
    toast('导入成功');
    await refresh();
  } catch (e) {
    toast(e.message, true);
  } finally {
    pendingImportFile = null;
    $('#fileInput').value = '';
    form.password.value = '';
    form.name.value = '';
  }
});

refresh().catch((e) => toast(e.message, true));
setInterval(() => {
  loadHealth().catch(() => {});
}, 5000);
