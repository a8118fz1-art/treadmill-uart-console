/*
 * protocol.js — 履帶跑步機 TFT UART 通訊協定編解碼
 * 框架：0xAA 0xBB CMD D1 D2 SUM   (SUM = 前五碼累加 & 0xFF)
 * 依據：履帶TFT_UART通訊碼按鍵定義-智奇20260724.xlsx
 */
(function (global) {
  'use strict';

  var HDR1 = 0xAA;
  var HDR2 = 0xBB;
  var FRAME_LEN = 6;

  // 方向：UP = 上控→下控、DOWN = 下控→上控、BI = 雙向
  var UP = 'UP', DOWN = 'DOWN', BI = 'BI';
  var DIR_LABEL = { UP: '上控→下控', DOWN: '下控→上控', BI: '雙向' };

  var CMD = {
    START:        0x00,
    RUN:          0x01,
    STOP:         0x02,
    SPEED_ADJ:    0x03,
    INCLINE_ADJ:  0x04,
    LOCK_OPEN:    0x05,
    RESIST_ADJ:   0x06,
    HUB_RESET:    0x07,
    WAKE_UP:      0x08,
    HEART:        0x09,
    LOCK_CLOSE:   0x0A,
    STANDBY:      0x0B,
    SPEED_FB:     0x0C,
    BUZZ_SHORT:   0x25,
    BUZZ_LONG:    0x26,
    KEEPALIVE:    0x55,
    STEPS:        0xC0,
    ENG_ACK:      0xC7,
    ENG_ENTER:    0xCA,
    ENG_VALUE:    0xCB,
    NO_SPEED_FB:  0xD0
  };

  function f1(n) { return (Math.round(n * 10) / 10).toFixed(1); }

  // 命令定義表。decode(d1, d2, mode) 回傳人類可讀說明。
  var TABLE = {};
  TABLE[CMD.START]       = { name: 'START',               dir: DOWN, group: 'ctrl' };
  TABLE[CMD.RUN]         = { name: '運行指令',             dir: BI,   group: 'ctrl',
    decode: function (d1, d2, mode) {
      return mode === 'resist'
        ? '阻力 ' + d1 + ' 段 ／ 揚昇 ' + d2 + ' 段'
        : '速度 ' + f1(d1 / 10) + ' km/h ／ 揚昇 ' + d2 + ' 段';
    } };
  TABLE[CMD.STOP]        = { name: '停機指令',             dir: BI,   group: 'ctrl' };
  TABLE[CMD.SPEED_ADJ]   = { name: '速度調整指令',          dir: DOWN, group: 'adj', needsRunReply: true,
    decode: function (d1, d2) { return '速度 ' + f1(d1 / 10) + ' km/h ／ 揚昇 ' + d2 + ' 段'; } };
  TABLE[CMD.INCLINE_ADJ] = { name: '坡度調整指令',          dir: DOWN, group: 'adj', needsRunReply: true,
    decode: function (d1, d2) { return '速度 ' + f1(d1 / 10) + ' km/h ／ 揚昇 ' + d2 + ' 段'; } };
  TABLE[CMD.LOCK_OPEN]   = { name: '安全鎖斷開',           dir: DOWN, group: 'lock' };
  TABLE[CMD.RESIST_ADJ]  = { name: '阻力調整指令',          dir: DOWN, group: 'adj', needsRunReply: true,
    decode: function (d1, d2) { return '阻力 ' + d1 + ' 段 ／ 揚昇 ' + d2 + ' 段'; } };
  TABLE[CMD.HUB_RESET]   = { name: 'Hub Reset',           dir: DOWN, group: 'sys' };
  TABLE[CMD.WAKE_UP]     = { name: 'Wake Up',             dir: DOWN, group: 'sys' };
  TABLE[CMD.HEART]       = { name: '心率',                 dir: DOWN, group: 'data',
    decode: function (d1) { return d1 + ' bpm'; } };
  TABLE[CMD.LOCK_CLOSE]  = { name: '安全鎖合上',           dir: DOWN, group: 'lock' };
  TABLE[CMD.STANDBY]     = { name: '系統待機',             dir: UP,   group: 'sys' };
  TABLE[CMD.SPEED_FB]    = { name: '即時速度回傳',          dir: DOWN, group: 'data',
    decode: function (d1, d2) { return f1((((d1 << 8) | d2)) / 10) + ' km/h（僅阻力模式）'; } };
  TABLE[CMD.BUZZ_SHORT]  = { name: '蜂鳴器短',             dir: DOWN, group: 'sys' };
  TABLE[CMD.BUZZ_LONG]   = { name: '蜂鳴器長',             dir: DOWN, group: 'sys' };
  TABLE[CMD.KEEPALIVE]   = { name: '存活訊號檢查',          dir: BI,   group: 'sys' };
  TABLE[CMD.STEPS]       = { name: '步數',                 dir: DOWN, group: 'data',
    decode: function (d1, d2) { return '+' + (((d1 << 8) | d2)) + ' 步（增量）'; } };
  TABLE[CMD.ENG_ACK]     = { name: '工程模式回應',          dir: DOWN, group: 'eng' };
  TABLE[CMD.ENG_ENTER]   = { name: '要求進入揚升工程模式',   dir: UP,   group: 'eng' };
  TABLE[CMD.ENG_VALUE]   = { name: '工程模式-揚升數值',      dir: DOWN, group: 'eng',
    decode: function (d1, d2) { return '目前揚升值 ' + d2 + ' 段'; } };
  TABLE[CMD.NO_SPEED_FB] = { name: '無速度迴授',            dir: DOWN, group: 'err' };

  // 錯誤碼 0xDA ~ 0xE7 → E1 ~ E14
  var ERRORS = [
    [0xDA, 'E1',  '運轉中輸入電壓過低',  '請檢查輸入電源'],
    [0xDB, 'E2',  'Encoder 異常',        '請檢查 Encoder'],
    [0xDC, 'E3',  '過載',                '請關電重新開機'],
    [0xDD, 'E4',  '直流母線電壓過高',    '請檢查輸入電源'],
    [0xDE, 'E5',  '溫度過高保護',        '請檢查散熱風扇'],
    [0xDF, 'E6',  '過電流保護',          '請關電重新開機並檢查負載'],
    [0xE0, 'E7',  '變頻器過載異常',      '請關電重新開機並檢查負載'],
    [0xE1, 'E8',  '卡鍵',                '檢查按鍵有無卡鍵'],
    [0xE2, 'E9',  '程式資料異常',        '請關電重新開機'],
    [0xE3, 'E10', '輸入電壓過低',        '請檢查輸入電源（電容電壓低於 197V）'],
    [0xE4, 'E11', '過載保護',            '請關電重新開機並檢查負載'],
    [0xE5, 'E12', '馬達過載異常',        '請關電重新開機／檢查馬達'],
    [0xE6, 'E13', '通訊錯誤',            '請檢查線材與接頭'],
    [0xE7, 'E14', '變頻器其他錯誤',      '請檢查下控燈號']
  ];
  var ERROR_MAP = {};
  ERRORS.forEach(function (e) {
    ERROR_MAP[e[0]] = { code: e[1], msg: e[2], fix: e[3] };
    TABLE[e[0]] = { name: e[1] + ' ' + e[2], dir: DOWN, group: 'err', error: true };
  });

  // 保留錯誤碼
  [0xE8, 0xE9, 0xEA, 0xEB, 0xEC, 0xED, 0xEF, 0xF0, 0xF1].forEach(function (c) {
    TABLE[c] = { name: '異常碼（保留）', dir: DOWN, group: 'err', error: true, reserved: true };
  });

  // ── 數值範圍 ────────────────────────────────────────────────
  var LIMITS = {
    speed:         { min: 0.5, max: 20.0, step: 0.1, raw: [0x05, 0xC8] },
    inclineSpeed:  { min: 0,   max: 20,   step: 1,   raw: [0x00, 0x14] },
    inclineResist: { min: 0,   max: 15,   step: 1,   raw: [0x00, 0x0F] },
    resistance:    { min: 0,   max: 100,  step: 1,   raw: [0x00, 0x64] }
  };

  // ── 工具 ────────────────────────────────────────────────────
  function hex(b, prefix) {
    var s = (b & 0xFF).toString(16).toUpperCase();
    if (s.length < 2) s = '0' + s;
    return (prefix === false ? '' : '0x') + s;
  }

  function bytesToHex(bytes) {
    return Array.prototype.map.call(bytes, function (b) { return hex(b, false); }).join(' ');
  }

  function hexToBytes(str) {
    var cleaned = String(str).replace(/0[xX]/g, ' ').replace(/[,\-]/g, ' ').trim();
    if (!cleaned) return null;
    var parts = cleaned.split(/\s+/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (!/^[0-9a-fA-F]{1,2}$/.test(parts[i])) return null;
      out.push(parseInt(parts[i], 16) & 0xFF);
    }
    return new Uint8Array(out);
  }

  function checksum(cmd, d1, d2) {
    return (HDR1 + HDR2 + (cmd & 0xFF) + (d1 & 0xFF) + (d2 & 0xFF)) & 0xFF;
  }

  function build(cmd, d1, d2) {
    d1 = d1 || 0; d2 = d2 || 0;
    return new Uint8Array([HDR1, HDR2, cmd & 0xFF, d1 & 0xFF, d2 & 0xFF, checksum(cmd, d1, d2)]);
  }

  function info(cmd) {
    return TABLE[cmd] || { name: '未定義命令', dir: null, group: 'unknown' };
  }

  function describe(cmd, d1, d2, mode) {
    var def = info(cmd);
    var text = def.name;
    if (def.decode) text += '：' + def.decode(d1, d2, mode);
    else if (def.error && ERROR_MAP[cmd]) text += '：' + ERROR_MAP[cmd].msg;
    return text;
  }

  // 速度 km/h ↔ raw
  function speedToRaw(kmh) { return Math.max(0, Math.min(0xFF, Math.round(kmh * 10))); }
  function rawToSpeed(raw) { return raw / 10; }

  // ── 串流解析器（自動同步起始碼、驗校驗和） ──────────────────
  function FrameParser(handlers) {
    this.buf = [];
    this.onFrame = (handlers && handlers.onFrame) || function () {};
    this.onError = (handlers && handlers.onError) || function () {};
  }

  FrameParser.prototype.reset = function () { this.buf = []; };

  FrameParser.prototype.push = function (chunk) {
    for (var i = 0; i < chunk.length; i++) this.buf.push(chunk[i] & 0xFF);

    while (this.buf.length > 0) {
      // 丟棄起始碼前的雜訊
      if (this.buf[0] !== HDR1) {
        var drop = this.buf.shift();
        this.onError({ type: 'noise', bytes: [drop] });
        continue;
      }
      if (this.buf.length < 2) return;             // 等待 0xBB
      if (this.buf[1] !== HDR2) {
        this.buf.shift();
        this.onError({ type: 'noise', bytes: [HDR1] });
        continue;
      }
      if (this.buf.length < FRAME_LEN) return;     // 等滿 6 bytes

      var frame = this.buf.slice(0, FRAME_LEN);
      var expect = checksum(frame[2], frame[3], frame[4]);
      if (expect !== frame[5]) {
        this.buf.shift();                          // 校驗失敗 → 前移一碼重新同步
        this.onError({ type: 'checksum', bytes: frame, expect: expect, got: frame[5] });
        continue;
      }
      this.buf.splice(0, FRAME_LEN);
      this.onFrame({
        bytes: new Uint8Array(frame),
        cmd: frame[2],
        d1: frame[3],
        d2: frame[4],
        sum: frame[5]
      });
    }
  };

  global.PROTO = {
    HDR1: HDR1, HDR2: HDR2, FRAME_LEN: FRAME_LEN,
    CMD: CMD, TABLE: TABLE, ERROR_MAP: ERROR_MAP, LIMITS: LIMITS,
    DIR: { UP: UP, DOWN: DOWN, BI: BI }, DIR_LABEL: DIR_LABEL,
    hex: hex, bytesToHex: bytesToHex, hexToBytes: hexToBytes,
    checksum: checksum, build: build, info: info, describe: describe,
    speedToRaw: speedToRaw, rawToSpeed: rawToSpeed,
    FrameParser: FrameParser
  };
})(window);
