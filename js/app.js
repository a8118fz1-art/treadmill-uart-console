/*
 * app.js — 工程上控台 UI 邏輯
 * 本端扮演「上控（Android / TFT 主機）」，透過 UART 與下控（Yade MCU 按鍵板）通訊。
 */
(function () {
  'use strict';

  var P = window.PROTO;
  var $ = function (id) { return document.getElementById(id); };

  var LOG_MAX = 3000;

  var S = {
    mode: 'speed',
    running: false,
    speed: 0.5,
    incline: 0,
    resist: 0,
    lock: null,          // true = 合上, false = 斷開
    hr: null,
    steps: 0,
    rtSpeed: null,
    engMode: false,
    engPending: false,
    engLift: null,
    engTimer: null,
    engTries: 0,
    kaTimer: null,
    kaSentAt: 0,
    kaRtt: null,
    aliveTimer: null,
    errors: [],
    paused: false,
    entries: [],
    port: null,
    stats: { txFrames: 0, rxFrames: 0, badSum: 0, noise: 0 },
    lastLiveSend: 0,
    lastAdjustKey: null,
    lastAdjustAt: 0,
    tripMs: 0,          // 運轉累計時間（上控自行計算）
    tripKm: 0,          // 累計距離（上控自行計算）
    tripTickAt: 0
  };

  var parser = new P.FrameParser({ onFrame: onFrame, onError: onParseError });

  // ── 工具 ──────────────────────────────────────────────────
  function ts(d) {
    d = d || new Date();
    function p(n, w) { return String(n).padStart(w || 2, '0'); }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function inclineMax() { return S.mode === 'resist' ? 15 : 20; }

  // ── 記錄 ──────────────────────────────────────────────────
  function pushEntry(e) {
    e.time = e.time || new Date();
    S.entries.push(e);
    if (S.entries.length > LOG_MAX) S.entries.splice(0, S.entries.length - LOG_MAX);
    if (!S.paused && matchFilter(e)) {
      var box = $('log');
      box.appendChild(renderEntry(e));
      while (box.childNodes.length > 1500) box.removeChild(box.firstChild);
      if ($('logScroll').checked) box.scrollTop = box.scrollHeight;
    }
  }

  function matchFilter(e) {
    var f = $('logFilter').value;
    if (f === 'all') return true;
    if (f === 'tx') return e.dir === 'TX';
    if (f === 'rx') return e.dir === 'RX';
    if (f === 'err') return !!e.bad || !!e.isError;
    return true;
  }

  function renderEntry(e) {
    var el = document.createElement('div');
    if (e.dir === '--') {
      el.className = 'l evt' + (e.isError ? ' bad' : '');
      el.innerHTML = '<span class="t"></span><span class="n"></span>';
      el.childNodes[0].textContent = ts(e.time);
      el.childNodes[1].textContent = e.note;
      return el;
    }
    el.className = 'l ' + (e.dir === 'TX' ? 'tx' : 'rx') + (e.bad ? ' bad' : '') + (e.isError ? ' errframe' : '');
    el.innerHTML = '<span class="t"></span><span class="d"></span><span class="h"></span><span class="n"></span>';
    el.childNodes[0].textContent = ts(e.time);
    el.childNodes[1].textContent = e.dir === 'TX' ? '→' : '←';
    el.childNodes[2].textContent = e.hex;
    el.childNodes[3].textContent = e.note;
    return el;
  }

  function rebuildLog() {
    var box = $('log');
    box.innerHTML = '';
    var list = S.entries.filter(matchFilter).slice(-1500);
    var frag = document.createDocumentFragment();
    list.forEach(function (e) { frag.appendChild(renderEntry(e)); });
    box.appendChild(frag);
    if ($('logScroll').checked) box.scrollTop = box.scrollHeight;
  }

  function event(note, isError) { pushEntry({ dir: '--', note: note, isError: !!isError }); }

  // ── 送出 ──────────────────────────────────────────────────
  function send(cmd, d1, d2, note) {
    if (!LINK.connected) { event('未連線，無法送出'); return; }
    var f = P.build(cmd, d1 || 0, d2 || 0);
    // 先記錄再送出：模擬器是同步回覆的，否則回應會排在送出之前
    S.stats.txFrames++;
    pushEntry({
      dir: 'TX', hex: P.bytesToHex(f),
      note: P.describe(cmd, d1 || 0, d2 || 0, S.mode) + (note ? '　' + note : '')
    });
    LINK.send(f).catch(function (err) { event('送出失敗：' + err.message); });
    updateStats();
  }

  function sendRaw(bytes) {
    if (!LINK.connected) { event('未連線，無法送出'); return; }
    S.stats.txFrames++;
    pushEntry({ dir: 'TX', hex: P.bytesToHex(bytes), note: '原始位元組（未驗校驗和）' });
    LINK.send(bytes).catch(function (err) { event('送出失敗：' + err.message); });
    updateStats();
  }

  /**
   * 目前實際帶速 km/h。速度模式等於上控下達的設定值，
   * 阻力模式取下控以 0x0C 回傳的實測值（協定規定只有阻力模式會回傳）。
   */
  function beltSpeed() {
    if (!S.running) return 0;
    if (S.mode === 'resist') return S.rtSpeed === null ? 0 : S.rtSpeed;
    return S.speed;
  }

  /** 距離與運轉時間由上控自行累計，協定不傳這兩項。 */
  function tripTick() {
    var now = Date.now();
    if (!S.running || !LINK.connected) { S.tripTickAt = now; return; }
    if (!S.tripTickAt) { S.tripTickAt = now; return; }
    var dt = now - S.tripTickAt;
    S.tripTickAt = now;
    if (dt <= 0 || dt > 5000) return;          // 分頁被凍結時不要灌入大段時間
    S.tripMs += dt;
    S.tripKm += beltSpeed() * (dt / 3600000);
  }

  function resetTrip() {
    S.steps = 0; S.tripMs = 0; S.tripKm = 0; S.tripTickAt = Date.now();
    render();
  }

  function fmtDuration(ms) {
    var t = Math.floor(ms / 1000);
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    function p(n) { return String(n).padStart(2, '0'); }
    return (h > 0 ? p(h) + ':' : '') + p(m) + ':' + p(sec);
  }

  /** 目前模式的運行指令 opcode：速度模式 0x01、阻力模式 0x06（見 docs/PROTOCOL.md §7）。 */
  function runCmd() {
    return S.mode === 'resist' ? P.CMD.RESIST_ADJ : P.CMD.RUN;
  }

  function sendRun(note) {
    var d1 = S.mode === 'resist' ? S.resist : P.speedToRaw(S.speed);
    send(runCmd(), d1, S.incline, note);
  }

  /** 滑桿調整時送出運行指令。input 與 change 會各觸發一次，短時間內相同的框略過。 */
  function sendAdjust(note) {
    var key = runCmd() + ':' + (S.mode === 'resist' ? S.resist : P.speedToRaw(S.speed)) + ':' + S.incline;
    var now = Date.now();
    if (key === S.lastAdjustKey && now - S.lastAdjustAt < 250) return;
    S.lastAdjustKey = key;
    S.lastAdjustAt = now;
    sendRun(note);
  }

  // ── 接收 ──────────────────────────────────────────────────
  function onParseError(e) {
    if (e.type === 'checksum') {
      S.stats.badSum++;
      pushEntry({
        dir: 'RX', hex: P.bytesToHex(e.bytes), bad: true,
        note: '校驗和錯誤：應為 ' + P.hex(e.expect) + '，實收 ' + P.hex(e.got) + '（已重新同步）'
      });
    } else {
      S.stats.noise += e.bytes.length;
    }
    updateStats();
  }

  function onFrame(f) {
    S.stats.rxFrames++;
    var def = P.info(f.cmd);
    pushEntry({
      dir: 'RX', hex: P.bytesToHex(f.bytes),
      note: P.describe(f.cmd, f.d1, f.d2, S.mode),
      isError: !!def.error
    });

    switch (f.cmd) {
      case P.CMD.START:
        event('下控按下 START —— 依協定需由上控回覆運行指令（' + P.hex(runCmd()) + '）才會啟動');
        break;

      case P.CMD.RUN:
        S.running = true;
        if (S.mode === 'resist') S.resist = f.d1; else S.speed = P.rawToSpeed(f.d1);
        S.incline = f.d2;
        syncSliders();
        break;

      case P.CMD.STOP:
        S.running = false;
        S.rtSpeed = null;
        break;

      case P.CMD.SPEED_ADJ:
      case P.CMD.INCLINE_ADJ:
        S.speed = clamp(P.rawToSpeed(f.d1), 0.5, 20);
        S.incline = clamp(f.d2, 0, inclineMax());
        syncSliders();
        autoRunReply();
        break;

      case P.CMD.RESIST_ADJ:
        S.resist = clamp(f.d1, 0, 100);
        S.incline = clamp(f.d2, 0, inclineMax());
        syncSliders();
        autoRunReply();
        break;

      case P.CMD.LOCK_OPEN:
        S.lock = false; S.running = false; S.rtSpeed = null;
        if (S.engMode || S.engPending) { exitEng('安全鎖斷開，已離開工程模式'); }
        break;

      case P.CMD.LOCK_CLOSE:
        S.lock = true;
        break;

      case P.CMD.HEART:
        S.hr = f.d1;
        break;

      case P.CMD.SPEED_FB:
        S.rtSpeed = ((f.d1 << 8) | f.d2) / 10;
        if (S.mode !== 'resist') {
          event('協定偏差：速度模式下收到即時速度回傳 0x0C（協定規定僅阻力模式使用）', true);
        }
        break;

      case P.CMD.STEPS:
        S.steps += ((f.d1 << 8) | f.d2);
        break;

      case P.CMD.KEEPALIVE:
        if (S.kaSentAt) { S.kaRtt = Date.now() - S.kaSentAt; S.kaSentAt = 0; }
        break;

      case P.CMD.ENG_ACK:
        S.engMode = true; S.engPending = false; S.engTries = 0;
        clearTimeout(S.engTimer); S.engTimer = null;
        event('已進入揚升工程模式（收到 0xC7）');
        break;

      case P.CMD.ENG_VALUE:
        S.engMode = true; S.engPending = false;
        clearTimeout(S.engTimer); S.engTimer = null;
        S.engLift = f.d2;
        break;

      case P.CMD.NO_SPEED_FB:
        addError(f.cmd, '無速度迴授', '下控每 0.5 秒重送，直到安全鎖斷開');
        break;

      case P.CMD.WAKE_UP:
        event('Wake Up：若為安全鎖觸發，下控仍會再送 0x05');
        break;

      default:
        if (def.error) {
          var em = P.ERROR_MAP[f.cmd];
          if (em) addError(f.cmd, em.code + '　' + em.msg, em.fix);
          else addError(f.cmd, '未定義異常碼 ' + P.hex(f.cmd), '保留碼，請確認韌體版本');
        }
        break;
    }
    render();
  }

  function autoRunReply() {
    if (!$('autoRunReply').checked) return;
    if (!S.running && !$('replyWhenStopped').checked) {
      event('已收到調整指令，但目前為停機狀態 → 未回覆 0x01（可於選項開啟）');
      return;
    }
    S.running = true;
    sendRun('← 依協定回覆調整指令');
  }

  function addError(cmd, msg, fix) {
    S.errors.unshift({ cmd: cmd, msg: msg, fix: fix, time: new Date() });
    if (S.errors.length > 50) S.errors.pop();
  }

  // ── 工程模式 ──────────────────────────────────────────────
  function enterEng() {
    S.engPending = true;
    S.engTries = 0;
    sendEngRequest();
  }

  function sendEngRequest() {
    S.engTries++;
    send(P.CMD.ENG_ENTER, 0, 0, S.engTries > 1 ? '（第 ' + S.engTries + ' 次重送）' : '');
    clearTimeout(S.engTimer);
    S.engTimer = setTimeout(function () {
      if (!S.engPending) return;
      if (S.engTries >= 6) {
        S.engPending = false;
        event('工程模式：重送 6 次仍未收到 0xC7，已停止重送');
        render();
        return;
      }
      event('工程模式：5 秒內未收到 0xC7 回應，重送 0xCA');
      sendEngRequest();
    }, 5000);
    render();
  }

  function exitEng(reason) {
    S.engMode = false; S.engPending = false; S.engLift = null;
    clearTimeout(S.engTimer); S.engTimer = null;
    if (reason) event(reason);
  }

  // ── 存活訊號 ──────────────────────────────────────────────
  function startKeepalive() {
    stopKeepalive();
    var iv = clamp(parseInt($('kaInterval').value, 10) || 1000, 200, 60000);
    S.kaTimer = setInterval(function () {
      if (!LINK.connected) return;
      S.kaSentAt = Date.now();
      send(P.CMD.KEEPALIVE, 0, 0);
    }, iv);
  }

  function stopKeepalive() {
    if (S.kaTimer) { clearInterval(S.kaTimer); S.kaTimer = null; }
    S.kaRtt = null; S.kaSentAt = 0;
  }

  // ── 畫面更新 ──────────────────────────────────────────────
  function syncSliders() {
    $('speed').value = S.speed;
    $('incline').value = S.incline;
    $('resist').value = S.resist;
    renderCtrlValues();
  }

  function renderCtrlValues() {
    $('speedVal').textContent = S.speed.toFixed(1);
    $('speedHex').textContent = P.hex(P.speedToRaw(S.speed));
    $('inclineVal').textContent = S.incline;
    $('inclineHex').textContent = P.hex(S.incline);
    $('resistVal').textContent = S.resist;
    $('resistHex').textContent = P.hex(S.resist);
    $('inclineMax').textContent = '上限 ' + inclineMax();
  }

  function render() {
    renderCtrlValues();

    // 帶速：阻力模式由下控以 0x0C 回傳，速度模式則等於上控下達的設定值
    if (S.mode === 'resist') {
      $('gSpeedLabel').innerHTML = '即時速度 <code>0x0C</code>';
      $('gSpeed').textContent = S.rtSpeed === null ? '—' : S.rtSpeed.toFixed(1);
    } else {
      $('gSpeedLabel').innerHTML = '帶速（設定值） <code>0x01</code>';
      $('gSpeed').textContent = (S.running ? S.speed : 0).toFixed(1);
    }
    $('gSteps').textContent = S.steps;
    $('gHr').textContent = S.hr === null ? '—' : S.hr;
    $('gIncline').textContent = S.incline;
    $('gResist').textContent = S.resist;
    $('gResistBox').hidden = (S.mode !== 'resist');
    $('gDist').textContent = S.tripKm.toFixed(2);
    $('gTime').textContent = fmtDuration(S.tripMs);

    var lock = $('gLock');
    lock.textContent = S.lock === null ? '未知' : (S.lock ? '合上' : '斷開');
    lock.className = 'tag' + (S.lock === null ? '' : (S.lock ? ' ok' : ' bad'));

    var run = $('gRun');
    run.textContent = S.running ? '運轉中' : '停止';
    run.className = 'tag' + (S.running ? ' ok' : '');
    $('btnRun').classList.toggle('active', S.running);
    $('btnRunCmd').textContent = P.hex(runCmd()) + ' 運行指令';

    var alive = $('gAlive');
    if (!LINK.connected) { alive.textContent = '—'; alive.className = 'tag'; }
    else if (S.kaRtt !== null) { alive.textContent = '正常 ' + S.kaRtt + ' ms'; alive.className = 'tag ok'; }
    else if (S.kaTimer) { alive.textContent = '等待回應'; alive.className = 'tag warn'; }
    else { alive.textContent = '未輪詢'; alive.className = 'tag'; }

    var pill = $('engPill');
    if (S.engMode) { pill.textContent = '工程模式中'; pill.className = 'pill on'; }
    else if (S.engPending) { pill.textContent = '等待 0xC7（第 ' + S.engTries + ' 次）'; pill.className = 'pill wait'; }
    else { pill.textContent = '未進入'; pill.className = 'pill'; }
    $('engLift').textContent = S.engLift === null ? '—' : S.engLift;

    renderErrors();
    updateStats();
  }

  function renderErrors() {
    var box = $('errBox');
    if (!S.errors.length) {
      box.className = 'errbox empty';
      box.textContent = '目前無異常';
      return;
    }
    box.className = 'errbox';
    box.innerHTML = '';
    S.errors.forEach(function (e) {
      var d = document.createElement('div');
      d.className = 'e';
      var c = document.createElement('span'); c.className = 'code'; c.textContent = P.hex(e.cmd);
      var m = document.createElement('div');
      var m1 = document.createElement('div'); m1.className = 'msg'; m1.textContent = e.msg;
      var m2 = document.createElement('div'); m2.className = 'fix'; m2.textContent = e.fix || '';
      m.appendChild(m1); m.appendChild(m2);
      var t = document.createElement('span'); t.className = 't'; t.textContent = ts(e.time);
      d.appendChild(c); d.appendChild(m); d.appendChild(t);
      box.appendChild(d);
    });
  }

  function updateStats() {
    $('stTx').textContent = S.stats.txFrames;
    $('stRx').textContent = S.stats.rxFrames;
    $('stBad').textContent = S.stats.badSum;
    $('stNoise').textContent = S.stats.noise;
    $('stTxB').textContent = LINK.stats.txBytes;
    $('stRxB').textContent = LINK.stats.rxBytes;
  }

  function setConnUI(connected) {
    $('btnConn').textContent = connected ? '中斷' : '連線';
    $('btnConn').classList.toggle('primary', !connected);
    ['btnRun', 'btnStop', 'btnEng', 'btnSend', 'btnSendRaw'].forEach(function (id) {
      $(id).disabled = !connected;
    });
    $('baud').disabled = connected;
    $('simMode').disabled = connected;
    $('btnPick').disabled = connected || $('simMode').checked;
    $('simPanel').classList.toggle('hidden', !(connected && LINK.kind === 'sim'));
  }

  // ── 命令速查表 ────────────────────────────────────────────
  var GROUP_LABEL = {
    ctrl: '運轉控制', adj: '調整指令（下控主動）', lock: '安全鎖',
    data: '資料回傳', sys: '系統', eng: '揚升工程模式', err: '異常碼'
  };

  function buildCmdTable() {
    var box = $('cmdTable');
    var order = ['ctrl', 'adj', 'lock', 'data', 'sys', 'eng', 'err'];
    var byGroup = {};
    Object.keys(P.TABLE).forEach(function (k) {
      var cmd = parseInt(k, 10);
      var def = P.TABLE[k];
      (byGroup[def.group] = byGroup[def.group] || []).push({ cmd: cmd, def: def });
    });
    order.forEach(function (g) {
      if (!byGroup[g]) return;
      var h = document.createElement('div');
      h.className = 'grp'; h.textContent = GROUP_LABEL[g] || g;
      box.appendChild(h);
      byGroup[g].sort(function (a, b) { return a.cmd - b.cmd; }).forEach(function (it) {
        var r = document.createElement('div');
        r.className = 'r' + (it.def.error ? ' err' : '');
        var c = document.createElement('span'); c.className = 'c'; c.textContent = P.hex(it.cmd);
        var n = document.createElement('span'); n.className = 'nm'; n.textContent = it.def.name;
        var d = document.createElement('span'); d.className = 'dr';
        d.textContent = it.def.dir ? P.DIR_LABEL[it.def.dir] : '';
        r.appendChild(c); r.appendChild(n); r.appendChild(d);
        r.addEventListener('click', function () {
          $('mCmd').value = P.hex(it.cmd, false);
          updateManualPreview();
        });
        box.appendChild(r);
      });
    });
  }

  function buildErrSelect() {
    var sel = $('simErr');
    Object.keys(P.ERROR_MAP).forEach(function (k) {
      var e = P.ERROR_MAP[k];
      var o = document.createElement('option');
      o.value = k;
      o.textContent = e.code + ' ' + P.hex(parseInt(k, 10)) + ' ' + e.msg;
      sel.appendChild(o);
    });
    var o2 = document.createElement('option');
    o2.value = String(P.CMD.NO_SPEED_FB);
    o2.textContent = '0xD0 無速度迴授';
    sel.appendChild(o2);
  }

  // ── 手動送框 ──────────────────────────────────────────────
  function readHexField(id) {
    var v = ($(id).value || '').trim().replace(/^0[xX]/, '');
    if (!/^[0-9a-fA-F]{1,2}$/.test(v)) return null;
    return parseInt(v, 16) & 0xFF;
  }

  function updateManualPreview() {
    var c = readHexField('mCmd'), a = readHexField('mD1'), b = readHexField('mD2');
    if (c === null || a === null || b === null) {
      $('mSum').value = '--';
      $('mPreview').textContent = '預覽：格式錯誤（請輸入 00~FF）';
      return;
    }
    var f = P.build(c, a, b);
    $('mSum').value = P.hex(f[5], false);
    $('mPreview').textContent = '預覽：' + P.bytesToHex(f) + '　→　' + P.describe(c, a, b, S.mode);
  }

  // ── 事件綁定 ──────────────────────────────────────────────
  function bind() {
    // 連線
    $('btnPick').addEventListener('click', function () {
      LINK.pickPort().then(function (port) {
        S.port = port;
        event('已選擇串列埠');
      }).catch(function (err) {
        if (err && err.name !== 'NotFoundError') event('選埠失敗：' + err.message);
      });
    });

    $('btnConn').addEventListener('click', function () {
      if (LINK.connected) { doDisconnect(); return; }
      var sim = $('simMode').checked;
      var baud = parseInt($('baud').value, 10);
      var pre = (sim || S.port) ? Promise.resolve(S.port) : LINK.pickPort().then(function (p) { S.port = p; return p; });
      pre.then(function (port) {
        return LINK.connect({ simulate: sim, port: port, baudRate: baud });
      }).then(function () {
        S.stats = { txFrames: 0, rxFrames: 0, badSum: 0, noise: 0 };
        parser.reset();
        setConnUI(true);
        if ($('autoKeepalive').checked) startKeepalive();
        render();
      }).catch(function (err) {
        if (err && err.name === 'NotFoundError') return;
        event('連線失敗：' + (err && err.message ? err.message : err));
      });
    });

    $('simMode').addEventListener('change', function () {
      $('btnPick').disabled = this.checked;
      $('baud').disabled = this.checked;
    });

    // 模式切換
    document.querySelectorAll('input[name=mode]').forEach(function (r) {
      r.addEventListener('change', function () {
        if (!this.checked) return;
        if (LINK.connected) {
          send(P.CMD.STOP, 0, 0, '（切換模式前依協定先停機）');
          S.running = false;
        }
        S.mode = this.value;
        S.rtSpeed = null;
        if (LINK.sim()) LINK.sim().trigger('setMode', S.mode);
        $('ctrlSpeed').hidden = (S.mode === 'resist');
        $('ctrlResist').hidden = (S.mode !== 'resist');
        $('incline').max = inclineMax();
        S.incline = clamp(S.incline, 0, inclineMax());
        syncSliders();
        event('已切換至' + (S.mode === 'resist' ? '阻力' : '速度') + '模式');
        render();
      });
    });

    // 運轉
    $('btnRun').addEventListener('click', function () { S.running = true; sendRun(); render(); });
    $('btnStop').addEventListener('click', function () {
      S.running = false; S.rtSpeed = null;
      send(P.CMD.STOP, 0, 0); render();
    });

    // 滑桿
    function onSlide(key, el, isFloat) {
      el.addEventListener('input', function () {
        S[key] = isFloat ? parseFloat(this.value) : parseInt(this.value, 10);
        renderCtrlValues();
        if (S.running && $('liveSend').checked && LINK.connected) {
          var now = Date.now();
          if (now - S.lastLiveSend > 120) { S.lastLiveSend = now; sendAdjust(); }
        }
      });
      el.addEventListener('change', function () {
        if (S.running && $('liveSend').checked && LINK.connected) sendAdjust();
      });
    }
    onSlide('speed', $('speed'), true);
    onSlide('incline', $('incline'), false);
    onSlide('resist', $('resist'), false);

    document.querySelectorAll('.btn.step').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = this.dataset.step, dir = parseInt(this.dataset.dir, 10);
        if (k === 'speed') S.speed = clamp(Math.round((S.speed + dir * 0.1) * 10) / 10, 0.5, 20);
        if (k === 'incline') S.incline = clamp(S.incline + dir, 0, inclineMax());
        if (k === 'resist') S.resist = clamp(S.resist + dir, 0, 100);
        syncSliders();
        if (S.running && $('liveSend').checked && LINK.connected) sendAdjust();
      });
    });

    // 快速指令
    document.querySelectorAll('[data-tx]').forEach(function (b) {
      b.addEventListener('click', function () {
        var cmd = parseInt(this.dataset.tx, 16);
        if (cmd === P.CMD.KEEPALIVE) S.kaSentAt = Date.now();
        send(cmd, 0, 0);
        render();
      });
    });

    // 存活訊號
    $('autoKeepalive').addEventListener('change', function () {
      if (this.checked && LINK.connected) startKeepalive(); else stopKeepalive();
      render();
    });
    $('kaInterval').addEventListener('change', function () {
      if ($('autoKeepalive').checked && LINK.connected) startKeepalive();
    });

    // 工程模式
    $('btnEng').addEventListener('click', enterEng);

    $('btnResetTrip').addEventListener('click', resetTrip);

    // 異常
    $('btnClearErr').addEventListener('click', function () { S.errors = []; renderErrors(); });

    // 記錄工具列
    $('logFilter').addEventListener('change', rebuildLog);
    $('btnPause').addEventListener('click', function () {
      S.paused = !S.paused;
      this.textContent = S.paused ? '繼續' : '暫停';
      this.classList.toggle('active', S.paused);
      if (!S.paused) rebuildLog();
    });
    $('btnClearLog').addEventListener('click', function () {
      S.entries = []; $('log').innerHTML = '';
    });
    $('btnExport').addEventListener('click', exportCsv);

    // 手動送框
    ['mCmd', 'mD1', 'mD2'].forEach(function (id) {
      $(id).addEventListener('input', updateManualPreview);
    });
    $('btnSend').addEventListener('click', function () {
      var c = readHexField('mCmd'), a = readHexField('mD1'), b = readHexField('mD2');
      if (c === null || a === null || b === null) { event('手動送框：欄位格式錯誤'); return; }
      send(c, a, b, '（手動）');
    });
    $('btnSendRaw').addEventListener('click', function () {
      var bytes = P.hexToBytes($('mRaw').value);
      if (!bytes || !bytes.length) { event('原始位元組格式錯誤'); return; }
      sendRaw(bytes);
    });

    // 模擬器
    document.querySelectorAll('[data-sim]').forEach(function (b) {
      b.addEventListener('click', function () {
        var sim = LINK.sim();
        if (!sim) { event('目前非模擬模式'); return; }
        var what = this.dataset.sim;
        if (what === 'error') {
          sim.trigger('error', parseInt($('simErr').value, 10));
        } else if (what === 'speedAdj' || what === 'inclineAdj') {
          sim.trigger(what, P.speedToRaw(S.speed), S.incline);
        } else if (what === 'resistAdj') {
          sim.trigger(what, S.resist, S.incline);
        } else {
          sim.trigger(what);
        }
      });
    });
    $('simLift').addEventListener('change', function () {
      var sim = LINK.sim();
      if (sim) sim.trigger('engLift', parseInt(this.value, 10) || 0);
    });
  }

  function doDisconnect() {
    stopKeepalive();
    exitEng();
    LINK.disconnect().then(function () {
      setConnUI(false);
      S.running = false;
      render();
    });
  }

  function exportCsv() {
    var rows = [['時間', '方向', 'HEX', '解碼']];
    S.entries.forEach(function (e) {
      rows.push([ts(e.time), e.dir === '--' ? 'EVENT' : e.dir, e.hex || '', (e.note || '').replace(/"/g, '""')]);
    });
    var csv = '﻿' + rows.map(function (r) {
      return r.map(function (c) { return '"' + c + '"'; }).join(',');
    }).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'uart-log-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  // ── 啟動 ──────────────────────────────────────────────────
  function init() {
    LINK.on('onData', function (bytes) { parser.push(bytes); });
    LINK.on('onStatus', function (state, msg) {
      var box = $('statusBox');
      box.className = 'status' + (state === 'connected' ? ' on' : state === 'error' ? ' err' : '');
      $('statusText').textContent = msg;
      if (state === 'disconnected' || state === 'error') {
        stopKeepalive(); exitEng(); setConnUI(false); S.running = false; render();
      }
    });

    if (!LINK.isSerialSupported()) $('unsupported').classList.remove('hidden');

    if (navigator.serial && navigator.serial.addEventListener) {
      navigator.serial.addEventListener('disconnect', function () {
        if (LINK.kind === 'serial' && LINK.connected) {
          event('串列埠已拔除');
          doDisconnect();
        }
      });
    }

    buildCmdTable();
    buildErrSelect();
    bind();
    updateManualPreview();
    setConnUI(false);
    syncSliders();
    render();

    // 距離／運轉時間累計
    setInterval(function () { tripTick(); render(); }, 1000);

    // 存活逾時監看
    setInterval(function () {
      if (!LINK.connected || !S.kaTimer) return;
      if (S.kaSentAt && Date.now() - S.kaSentAt > 3000) { S.kaRtt = null; render(); }
    }, 1000);

    event('工程上控台就緒。協定：0xAA 0xBB CMD D1 D2 SUM（SUM = 前五碼累加 & 0xFF）');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
