const $ = (sel) => document.querySelector(sel);

let health = { imaRunning: false, imaFound: false, current: null };
let accountsCache = [];
let pendingExportId = null;
let pendingImportFile = null;
let pendingSwitchId = null;
let oauthSessionId = null;
let oauthPollTimer = null;
let lastMatchedId = null;
let qrRetrySession = null;
let qrWxCode = null;

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

function avatarHtml(a, cls) {
  if (a?.avatarUrl) {
    return `<img src="${escapeHtml(a.avatarUrl)}" alt="" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createTextNode('${escapeHtml(initials(a.nickname || a.name))}'))" />`;
  }
  return escapeHtml(initials(a?.nickname || a?.name));
}

function fmtTime(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

function setNav(view) {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  $('#view-accounts').hidden = view !== 'accounts';
  $('#view-benefit').hidden = view !== 'benefit';
  $('#view-paths').hidden = view !== 'paths';
  if (view === 'benefit') {
    loadBenefit().catch((e) => toast(e.message, true));
  }
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.onclick = () => setNav(btn.dataset.view);
});

async function loadHealth() {
  health = await api('/api/health');
  $('#imaPath').textContent = health.imaUserData || '-';
  $('#imaExe').textContent = health.imaExe || '-';
  $('#vaultPath').textContent = health.vaultRoot || '-';
  $('#imaRunState').textContent = health.imaRunning ? '运行中' : '未运行';
  const dot = $('#runDot');
  const text = $('#runText');
  if (health.imaRunning) {
    dot.className = 'dot on';
    text.textContent = 'IMA 运行中';
  } else {
    dot.className = 'dot off';
    text.textContent = health.imaFound ? 'IMA 未运行' : '未找到 IMA';
  }
  const btnLaunch = $('#btnLaunchIma');
  if (btnLaunch) btnLaunch.textContent = health.imaRunning ? '重启 IMA' : '启动 IMA';
}

function renderCurrent(current, matched) {
  const banner = $('#currentBanner');
  if (!current?.userId) {
    banner.hidden = true;
    lastMatchedId = null;
    return;
  }
  banner.hidden = false;
  $('#currentAvatar').innerHTML = avatarHtml(current);
  $('#currentDesc').innerHTML =
    `${escapeHtml(current.nickname || '未命名')} · uid <code>${escapeHtml(current.userId)}</code>` +
    (current.openid ? ` · openid <code>${escapeHtml(current.openid)}</code>` : '') +
    (matched ? ` · 已对应「${escapeHtml(matched.name)}」` : '');
  const loginTag = $('#currentLoginTag');
  loginTag.textContent = current.isLoggedIn ? '已登录' : '状态未知';
  loginTag.className = `tag ${current.isLoggedIn ? 'ok' : 'warn'}`;
  const matchTag = $('#currentMatchTag');
  matchTag.hidden = !matched;
  lastMatchedId = matched?.id || null;
  $('#btnUpdateCurrent').textContent = matched ? `更新「${matched.name}」` : '保存为账号';
}

function renderAccounts(accounts, currentUserId) {
  accountsCache = accounts;
  const box = $('#accounts');
  box.innerHTML = '';
  $('#empty').hidden = accounts.length > 0;
  $('#accountCount').textContent = String(accounts.length);

  for (const a of accounts) {
    const isCurrent = !!(currentUserId && a.userId === currentUserId);
    const card = document.createElement('article');
    card.className = `card${isCurrent ? ' is-current' : ''}`;
    card.innerHTML = `
      <div class="card-top">
        <div class="card-avatar">${avatarHtml(a)}</div>
        <div>
          <div class="card-name">${escapeHtml(a.name)}</div>
          <div class="card-nick">${escapeHtml(a.nickname || '—')}</div>
        </div>
        <div class="card-badges">
          ${isCurrent ? '<span class="tag now">当前</span>' : ''}
          <span class="tag">${escapeHtml(a.source || 'local')}</span>
        </div>
      </div>
      <div class="card-body">
        <div class="card-meta">
          <span>uid <code>${escapeHtml(a.userId || '-')}</code></span>
          <span>更新 ${escapeHtml(fmtTime(a.updatedAt))}</span>
        </div>
        ${a.note ? `<div style="margin-top:6px">备注：${escapeHtml(a.note)}</div>` : ''}
      </div>
      <div class="card-ops"></div>
    `;
    const ops = card.querySelector('.card-ops');

    const btnSwitch = document.createElement('button');
    btnSwitch.className = 'btn primary sm';
    btnSwitch.textContent = isCurrent ? '重新应用' : '切换';
    btnSwitch.onclick = () => openSwitch(a, isCurrent);

    const btnResave = document.createElement('button');
    btnResave.className = 'btn sm';
    btnResave.textContent = '覆盖保存';
    btnResave.onclick = () => pendingResave(a);

    const btnExport = document.createElement('button');
    btnExport.className = 'btn sm';
    btnExport.textContent = '导出';
    btnExport.onclick = () => openExport(a);

    const btnDelete = document.createElement('button');
    btnDelete.className = 'btn danger sm';
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
    box.appendChild(card);
  }
}

async function refresh() {
  await loadHealth();
  const { accounts, current } = await api('/api/accounts');
  const matched =
    current?.userId && accounts.find((x) => x.userId === current.userId)
      ? accounts.find((x) => x.userId === current.userId)
      : null;
  renderCurrent(current || health.current, matched);
  renderAccounts(accounts, current?.userId);
}

async function pendingResave(account) {
  const msg = health.imaRunning
    ? `将强制关闭 IMA，并用当前登录状态覆盖「${account.name}」？`
    : `用当前 IMA 登录状态覆盖「${account.name}」？`;
  if (!confirm(msg)) return;
  try {
    await api(`/api/accounts/${encodeURIComponent(account.id)}/resave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forceStop: true }),
    });
    toast('已覆盖保存');
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
}

function openSwitch(account, isCurrent = false) {
  pendingSwitchId = account.id;
  const nick = account.nickname ? `（${account.nickname}）` : '';
  $('#switchMsg').textContent = isCurrent
    ? `「${account.name}」${nick} 已是当前登录。将强制关闭 IMA 并重新写入该档案。`
    : `将切换到「${account.name}」${nick}。IMA 若正在运行会被强制关闭。`;
  $('#dlgSwitch').showModal();
}

function openExport(account) {
  pendingExportId = account.id || lastMatchedId;
  if (!pendingExportId) {
    toast('请先在账号卡片上选择「导出」', true);
    return;
  }
  $('#exportMsg').textContent = `导出「${account.name || '账号'}」的登录态快照。`;
  $('#dlgExport').showModal();
}

$('#btnRefresh').onclick = () => refresh().catch((e) => toast(e.message, true));

$('#btnSave').onclick = () => {
  $('#saveForm').name.value = health.current?.nickname || '';
  $('#saveForm').note.value = '';
  $('#dlgSave').showModal();
};

$('#btnUpdateCurrent').onclick = async () => {
  if (lastMatchedId) {
    const acc = accountsCache.find((a) => a.id === lastMatchedId);
    if (acc) return pendingResave(acc);
  }
  $('#btnSave').click();
};

$('#btnLaunchIma').onclick = async () => {
  try {
    if (health.imaRunning) {
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

$('#btnExportCurrent').onclick = () => {
  if (!lastMatchedId) {
    toast('当前登录尚未对应本地档案，请先「保存当前账号」', true);
    return;
  }
  const acc = accountsCache.find((a) => a.id === lastMatchedId);
  openExport(acc || { id: lastMatchedId, name: '当前账号' });
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
      body: JSON.stringify({ name, note: form.note.value, forceStop: true }),
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
    toast('正在强制关闭 IMA 并切换…');
    await api(`/api/accounts/${encodeURIComponent(pendingSwitchId)}/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ launch }),
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

function setOauthStatus(kind, msg) {
  $('#oauthStatus').hidden = false;
  $('#oauthDot').className = `dot ${kind}`;
  $('#oauthMsg').textContent = msg;
}

function stopOauthPoll() {
  if (oauthPollTimer) {
    clearInterval(oauthPollTimer);
    oauthPollTimer = null;
  }
  oauthSessionId = null;
}

async function pollOauth() {
  if (!oauthSessionId) return;
  try {
    const { session } = await api(`/api/oauth/${encodeURIComponent(oauthSessionId)}`);
    if (!session) {
      stopOauthPoll();
      setOauthStatus('err', '会话不存在');
      return;
    }
    if (session.status === 'waiting' || session.status === 'checking') {
      setOauthStatus('on', session.message || '请在独立窗口扫码登录…');
      return;
    }
    if (session.status === 'done') {
      stopOauthPoll();
      setOauthStatus('ok', session.message || '已添加');
      toast(session.message || '扫码账号已添加');
      $('#oauthStartBtn').disabled = false;
      $('#oauthStartBtn').textContent = '完成';
      await refresh();
      return;
    }
    if (session.status === 'failed' || session.status === 'cancelled') {
      stopOauthPoll();
      setOauthStatus('err', session.message || '失败');
      $('#oauthStartBtn').disabled = false;
      $('#oauthStartBtn').textContent = '重试打开登录窗口';
    }
  } catch (e) {
    setOauthStatus('err', e.message);
  }
}

$('#btnOauth').onclick = () => {
  $('#oauthName').value = '';
  $('#oauthStatus').hidden = true;
  $('#oauthStartBtn').disabled = false;
  $('#oauthStartBtn').textContent = '打开登录窗口';
  stopOauthPoll();
  showOauthPane('qr');
  loadQrFrame().catch((e) => setQrStatus('err', e.message));
  $('#dlgOauth').showModal();
};

function showOauthPane(which) {
  $('#paneQr').hidden = which !== 'qr';
  $('#paneWindow').hidden = which !== 'window';
  $('#tabQr').classList.toggle('primary', which === 'qr');
  $('#tabWindow').classList.toggle('primary', which === 'window');
}

$('#tabQr').onclick = () => {
  showOauthPane('qr');
  loadQrFrame().catch((e) => setQrStatus('err', e.message));
};
$('#tabWindow').onclick = () => showOauthPane('window');
$('#qrWindowFallback').onclick = () => showOauthPane('window');
$('#qrRefreshBtn').onclick = () => loadQrFrame().catch((e) => setQrStatus('err', e.message));

function setQrStatus(kind, msg) {
  $('#qrStatus').hidden = false;
  $('#qrDot').className = `dot ${kind}`;
  $('#qrMsg').textContent = msg;
}

async function loadQrFrame() {
  setQrStatus('on', '正在加载微信二维码…');
  const info = await api('/api/oauth/qr');
  qrRetrySession = info.retrySession;
  qrWxCode = null;
  // Prefer official WeChat qrconnect iframe (ima appid). After scan, iframe redirects to ima.qq.com.
  const frame = $('#qrFrame');
  // Use IMA universal wrapper so scan UX matches official; still listen for any code messages.
  frame.src = info.imaQrUrl;
  setQrStatus('on', '请使用微信扫描二维码');
}

// Listen for any postMessage that might carry a WeChat code
window.addEventListener('message', async (ev) => {
  const data = ev.data;
  if (!data || typeof data !== 'object') return;
  const eventName = data.eventName || data.type;
  if (eventName === 'loginWxCodeReady' && data.data?.code) {
    await completeWxCode(data.data.code);
    return;
  }
  // WeChat jssdk style
  if ((data.code || data.data?.code) && (eventName === 'wx_login' || data.type === 'wx_login' || data.status === 'wx_login')) {
    await completeWxCode(data.code || data.data.code);
  }
});

async function completeWxCode(code) {
  if (!code || qrWxCode === code) return;
  qrWxCode = code;
  setQrStatus('on', '已获取登录凭证，正在入库…');
  try {
    const name = $('#oauthName').value.trim() || undefined;
    await api('/api/oauth/wx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name }),
    });
    setQrStatus('ok', '扫码账号已添加');
    toast('扫码账号已添加');
    await refresh();
  } catch (e) {
    setQrStatus('err', e.message);
    toast(e.message, true);
    qrWxCode = null;
  }
}

$('#oauthCancelBtn').onclick = () => $('#dlgOauth').close('cancel');

$('#oauthStartBtn').onclick = async () => {
  const name = $('#oauthName').value.trim();
  try {
    $('#oauthStartBtn').disabled = true;
    $('#oauthStartBtn').textContent = '正在启动…';
    setOauthStatus('on', '正在打开隔离的 IMA 登录窗口…');
    const { session } = await api('/api/oauth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    oauthSessionId = session.id;
    setOauthStatus('on', session.message || '请在新窗口扫码登录');
    $('#oauthStartBtn').textContent = '等待扫码…';
    stopOauthPoll();
    oauthPollTimer = setInterval(pollOauth, 2000);
    await pollOauth();
  } catch (e) {
    setOauthStatus('err', e.message);
    $('#oauthStartBtn').disabled = false;
    $('#oauthStartBtn').textContent = '重试打开登录窗口';
  }
};

$('#dlgOauth').addEventListener('close', async () => {
  if (oauthSessionId) {
    try {
      await api(`/api/oauth/${encodeURIComponent(oauthSessionId)}/cancel`, { method: 'POST' });
    } catch {
      // ignore
    }
  }
  stopOauthPoll();
  await refresh().catch(() => {});
});

async function loadBenefit() {
  $('#benefitStatus').textContent = '加载中…';
  const data = await api('/api/benefit');
  const acts = data.activities || [];
  const a0 = acts[0];
  const daily = a0?.dailyInfo;
  if (daily) {
    $('#benefitStatus').textContent =
      `当前账号：${data.nickname || data.userId} · 签到 ${daily.checkinDays} 天 · 累计 ${daily.totalRewardPoints} 算力` +
      (daily.claimedToday ? ' · 今日已领取' : ' · 今日待领取');
  } else {
    $('#benefitStatus').textContent = `当前账号：${data.nickname || data.userId}`;
  }
  const box = $('#benefitList');
  box.innerHTML = '';
  if (!acts.length) {
    box.innerHTML = '<p class="empty">没有每日登录福利数据</p>';
    return;
  }
  for (const a of acts) {
    const card = document.createElement('article');
    card.className = `card${a.finished ? '' : ' is-current'}`;
    const days = a.dailyInfo?.infos || [];
    const dayRows = days
      .map((d) => `<div>${escapeHtml(d.top)} · ${escapeHtml(d.button)} · ${escapeHtml(d.reward)}</div>`)
      .join('');
    card.innerHTML = `
      <div class="card-top">
        <div class="card-avatar">✦</div>
        <div>
          <div class="card-name">${escapeHtml(a.title)}</div>
          <div class="card-nick">${escapeHtml(a.description || '')}</div>
        </div>
        <div class="card-badges">
          <span class="tag ${a.finished ? '' : 'ok'}">${a.finished ? '今日已领' : '可领取'}</span>
        </div>
      </div>
      <div class="card-body">${dayRows}</div>
    `;
    box.appendChild(card);
  }
}

$('#btnRefreshBenefit')?.addEventListener('click', () => {
  loadBenefit().catch((e) => toast(e.message, true));
});
$('#btnClaimBenefit')?.addEventListener('click', async () => {
  const btn = $('#btnClaimBenefit');
  btn.disabled = true;
  try {
    $('#benefitStatus').textContent = '正在领取每日登录算力…';
    const data = await api('/api/benefit/claim', { method: 'POST' });
    const ok = data.claimed.filter((c) => c.ok);
    const fail = data.claimed.filter((c) => !c.ok);
    if (ok.length) toast(`已领取 ${ok.length} 项：${ok.map((c) => c.title).join('、')}`);
    else if (fail.length) toast(fail[0].error || '领取失败', true);
    else toast('今日没有可领取的每日登录福利（可能已领完）');
    await loadBenefit();
  } catch (e) {
    toast(e.message, true);
    $('#benefitStatus').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

$('#btnClaimAllBenefit')?.addEventListener('click', async () => {
  const btn = $('#btnClaimAllBenefit');
  btn.disabled = true;
  try {
    $('#benefitStatus').textContent = '正在遍历账号并领取…';
    const data = await api('/api/benefit/claim-all', { method: 'POST' });
    await loadBenefit();
    const lines = data.results.map((r) => `${r.ok ? '✓' : '✗'} ${r.label}: ${r.error || r.message}`);
    const okCount = data.results.filter((r) => r.ok).length;
    $('#benefitStatus').innerHTML =
      `多账号领取：${okCount}/${data.results.length}<br/>` + lines.map(escapeHtml).join('<br/>');
    toast(`多账号领取完成：${okCount}/${data.results.length}`);
  } catch (e) {
    toast(e.message, true);
    $('#benefitStatus').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

refresh().catch((e) => toast(e.message, true));
setInterval(() => {
  refresh().catch(() => {});
}, 5000);
