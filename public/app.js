const $ = (sel) => document.querySelector(sel);

let health = { imaRunning: false, imaFound: false, current: null };
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

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function initials(name) {
  const s = String(name || '?').trim();
  return s.slice(0, 1).toUpperCase() || '?';
}

function avatarEl(a) {
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  if (a?.avatarUrl) {
    const img = document.createElement('img');
    img.src = a.avatarUrl;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => {
      avatar.textContent = initials(a.nickname || a.name);
    };
    avatar.appendChild(img);
  } else {
    avatar.textContent = initials(a?.nickname || a?.name);
  }
  return avatar;
}

function fmtTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
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

function renderCurrent(current, imaRunning, matched) {
  const box = $('#currentCard');
  const empty = $('#currentEmpty');
  box.innerHTML = '';
  if (!current || !current.userId) {
    empty.hidden = false;
    empty.textContent = imaRunning
      ? 'IMA 正在运行，但未能读取当前登录身份。'
      : 'IMA 未运行，或本地没有可读的登录信息。';
    return;
  }
  empty.hidden = true;

  const card = document.createElement('article');
  card.className = 'card card-current';
  const badge = document.createElement('div');
  badge.className = 'badge';
  badge.textContent = matched ? '当前 · 已存档' : '当前登录';
  const avatar = avatarEl(current);
  const mid = document.createElement('div');
  mid.innerHTML = `
    <div class="name">
      ${escapeHtml(current.nickname || '未命名账号')}
      <span class="tag ${current.isLoggedIn ? 'ok' : 'warn'}">${current.isLoggedIn ? '已登录' : '状态未知'}</span>
    </div>
    <div class="desc">
      uid <code>${escapeHtml(current.userId)}</code>
      ${current.openid ? ` · openid <code>${escapeHtml(current.openid)}</code>` : ''}
      ${matched ? `<br/>已对应档案：<strong>${escapeHtml(matched.name)}</strong>（<code>${escapeHtml(matched.id)}</code>）` : ''}
    </div>`;
  const ops = document.createElement('div');
  ops.className = 'ops';
  const btnSaveAs = document.createElement('button');
  btnSaveAs.className = 'btn primary';
  btnSaveAs.textContent = matched ? '更新该档案' : '保存为账号';
  btnSaveAs.onclick = () => {
    if (matched) {
      pendingResave(matched);
    } else {
      $('#saveForm').name.value = current.nickname || '';
      $('#saveForm').note.value = '';
      $('#dlgSave').showModal();
    }
  };
  const btnLaunch = document.createElement('button');
  btnLaunch.className = 'btn';
  btnLaunch.textContent = imaRunning ? '重启 IMA' : '启动 IMA';
  btnLaunch.onclick = async () => {
    try {
      if (imaRunning) {
        await api('/api/ima/restart', { method: 'POST' });
        toast('IMA 已重启');
      } else {
        await api('/api/ima/launch', { method: 'POST' });
        toast('IMA 已启动');
      }
      await refresh();
    } catch (e) {
      toast(e.message, true);
    }
  };
  ops.append(btnSaveAs, btnLaunch);
  card.append(avatar, mid, ops);
  // badge overlays first column visually via CSS grid
  card.prepend(badge);
  box.appendChild(card);
}

async function pendingResave(account) {
  if (!confirm(`用当前 IMA 登录状态覆盖「${account.name}」？`)) return;
  try {
    await api(`/api/accounts/${encodeURIComponent(account.id)}/resave`, { method: 'POST' });
    toast('已覆盖保存');
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
}

function renderAccounts(accounts, currentUserId) {
  const box = $('#accounts');
  box.innerHTML = '';
  $('#empty').hidden = accounts.length > 0;
  $('#accountCount').textContent = accounts.length ? `（${accounts.length}）` : '';

  for (const a of accounts) {
    const isCurrent = !!(currentUserId && a.userId === currentUserId);
    const card = document.createElement('article');
    card.className = `card${isCurrent ? ' is-current' : ''}`;
    if (isCurrent) {
      const tag = document.createElement('span');
      tag.className = 'current-pill';
      tag.textContent = '当前使用中';
      card.appendChild(tag);
    }
    card.appendChild(avatarEl(a));
    const mid = document.createElement('div');
    mid.innerHTML = `
      <div class="name">
        ${escapeHtml(a.name)}
        ${a.nickname ? ` <span class="muted-nick">· ${escapeHtml(a.nickname)}</span>` : ''}
      </div>
      <div class="desc">
        档案 <code>${escapeHtml(a.id)}</code>
        ${a.userId ? ` · uid <code>${escapeHtml(a.userId)}</code>` : ''}
        <br/>
        更新 ${escapeHtml(fmtTime(a.updatedAt) || '-')}
        ${a.lastUsedAt ? ` · 上次使用 ${escapeHtml(fmtTime(a.lastUsedAt))}` : ''}
        ${a.note ? `<br/>备注：${escapeHtml(a.note)}` : ''}
      </div>`;
    const ops = document.createElement('div');
    ops.className = 'ops';

    const btnSwitch = document.createElement('button');
    btnSwitch.className = 'btn primary';
    btnSwitch.textContent = isCurrent ? '重新应用' : '切换到此账号';
    btnSwitch.disabled = isCurrent && !health.imaFound;
    btnSwitch.onclick = () => openSwitch(a, isCurrent);

    const btnResave = document.createElement('button');
    btnResave.className = 'btn';
    btnResave.textContent = '覆盖保存';
    btnResave.onclick = () => pendingResave(a);

    const btnExport = document.createElement('button');
    btnExport.className = 'btn';
    btnExport.textContent = '导出';
    btnExport.onclick = () => openExport(a);

    const btnDelete = document.createElement('button');
    btnDelete.className = 'btn danger';
    btnDelete.textContent = '删除';
    btnDelete.onclick = async () => {
      if (!confirm(`删除账号「${a.name}」？此操作不可恢复。`)) return;
      try {
        await api(`/api/accounts/${encodeURIComponent(a.id)}`, { method: 'DELETE' });
        toast('已删除');
        await refresh();
      } catch (e) {
        toast(e.message, true);
      }
    };

    ops.append(btnSwitch, btnResave, btnExport, btnDelete);
    card.append(mid, ops);
    box.appendChild(card);
  }
}

async function refresh() {
  await loadHealth();
  const { accounts, current, imaRunning } = await api('/api/accounts');
  const matched =
    current?.userId && accounts.find((a) => a.userId === current.userId)
      ? accounts.find((a) => a.userId === current.userId)
      : null;
  renderCurrent(current || health.current, imaRunning ?? health.imaRunning, matched);
  renderAccounts(accounts, current?.userId);
}

function openSwitch(account, isCurrent = false) {
  pendingSwitchId = account.id;
  const nick = account.nickname ? `（${account.nickname}）` : '';
  $('#switchMsg').textContent = isCurrent
    ? `「${account.name}」${nick} 已是当前登录。将重新写入该档案的登录态（当前状态会先备份）。`
    : `将切换到「${account.name}」${nick}。当前登录状态会先备份，IMA 若在运行会先关闭。`;
  $('#dlgSwitch').showModal();
}

function openExport(account) {
  pendingExportId = account.id;
  $('#exportMsg').textContent = `导出「${account.name}」的登录态快照。`;
  $('#dlgExport').showModal();
}

$('#btnRefresh').onclick = () => refresh().catch((e) => toast(e.message, true));

$('#btnSave').onclick = () => {
  const nick = health.current?.nickname || '';
  $('#saveForm').name.value = nick;
  $('#saveForm').note.value = '';
  $('#dlgSave').showModal();
};

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
  refresh().catch(() => {});
}, 4000);
