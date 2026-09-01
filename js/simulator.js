/*
 * simulator.js — 下控（Yade MCU 按鍵板）模擬器
 * 無實體硬體時，可用來驗證上控端的協定實作與 UI 流程。
 */
(function (global) {
  'use strict';

  var P = global.PROTO;

  function SimDevice(io) {
    this.io = io;                       // { send(Uint8Array) }
    this.parser = new P.FrameParser({ onFrame: this._onFrame.bind(this) });
    this.state = {
      running: false,
      mode: 'speed',                    // 'speed' | 'resist'
      speedRaw: 0x05,
      incline: 0,
      resistance: 0,
      lockClosed: true,
      engMode: false,
      engLift: 0,
      hr: 0,
      actualSpeed: 0                    // 阻力模式下的實際帶速 (km/h)
    };
    this.timers = [];
    this.log = function () {};
  }

  SimDevice.prototype.start = function () {
    var self = this;
    // 心跳類週期任務
    this.timers.push(setInterval(function () { self._tick1s(); }, 1000));
    this.timers.push(setInterval(function () { self._tick500ms(); }, 500));
  };

  SimDevice.prototype.stop = function () {
    this.timers.forEach(clearInterval);
    this.timers = [];
  };

  SimDevice.prototype._send = function (cmd, d1, d2) {
    if (this.io && this.io.send) this.io.send(P.build(cmd, d1 || 0, d2 || 0));
  };

  /** 由連線層餵入上控送來的位元組 */
  SimDevice.prototype.receive = function (bytes) {
    this.parser.push(bytes);
  };

  SimDevice.prototype._onFrame = function (f) {
    var s = this.state;
    switch (f.cmd) {
      case P.CMD.RUN:                                   // 0x01 運行
        s.running = true;
        if (s.mode === 'resist') { s.resistance = f.d1; } else { s.speedRaw = f.d1; }
        s.incline = f.d2;
        break;
      case P.CMD.STOP:                                  // 0x02 停機
        s.running = false;
        s.actualSpeed = 0;
        break;
      // 0x06 下行 = 阻力模式的運行指令（見 docs/PROTOCOL.md §7）。
      // 0x03 / 0x04 只由按鍵板上行，上控不會送，故此處不處理。
      case P.CMD.RESIST_ADJ:
        s.running = true;
        s.mode = 'resist';
        s.resistance = f.d1;
        s.incline = f.d2;
        break;
      case P.CMD.KEEPALIVE:                             // 0x55 存活訊號 → 原碼回覆
        this._send(P.CMD.KEEPALIVE, 0x00, 0x00);
        break;
      case P.CMD.ENG_ENTER:                             // 0xCA 進工程模式 → 0xC7 回應
        s.engMode = true;
        this._send(P.CMD.ENG_ACK, 0x00, 0x00);
        break;
      case P.CMD.STANDBY:                               // 0x0B 系統待機
        s.running = false;
        break;
      default:
        break;
    }
  };

  SimDevice.prototype._tick1s = function () {
    var s = this.state;
    if (!s.running || !s.lockClosed) return;

    if (s.mode === 'resist') {
      // 阻力模式：帶速由使用者踩踏產生，模擬為受阻力影響的隨機速度
      var target = Math.max(0, 12 - s.resistance * 0.08) + (Math.random() * 1.2 - 0.6);
      s.actualSpeed = Math.max(0.5, Math.min(50, s.actualSpeed * 0.7 + target * 0.3));
      var raw = Math.round(s.actualSpeed * 10);
      this._send(P.CMD.SPEED_FB, (raw >> 8) & 0xFF, raw & 0xFF);   // 0x0C 即時速度
    }

    // 0xC0 步數（增量）
    var kmh = s.mode === 'resist' ? s.actualSpeed : s.speedRaw / 10;
    var steps = Math.round(kmh * 2.2);
    if (steps > 0) this._send(P.CMD.STEPS, (steps >> 8) & 0xFF, steps & 0xFF);

    // 0x09 心率（每 2 秒）
    this._hrTick = (this._hrTick || 0) + 1;
    if (this._hrTick % 2 === 0) {
      s.hr = Math.round(90 + kmh * 3 + (Math.random() * 6 - 3));
      this._send(P.CMD.HEART, Math.min(255, s.hr), 0x00);
    }
  };

  SimDevice.prototype._tick500ms = function () {
    // 工程模式：持續回報目前揚升值
    if (this.state.engMode) {
      this._send(P.CMD.ENG_VALUE, 0x00, this.state.engLift & 0xFF);
    }
  };

  // ── 手動觸發（模擬按鍵板動作） ────────────────────────────
  SimDevice.prototype.trigger = function (what, a, b) {
    var s = this.state;
    switch (what) {
      case 'start':      this._send(P.CMD.START, 0, 0); break;
      case 'stop':       s.running = false; this._send(P.CMD.STOP, 0, 0); break;
      case 'speedAdj':   this._send(P.CMD.SPEED_ADJ, a & 0xFF, b & 0xFF); break;
      case 'inclineAdj': this._send(P.CMD.INCLINE_ADJ, a & 0xFF, b & 0xFF); break;
      case 'resistAdj':  this._send(P.CMD.RESIST_ADJ, a & 0xFF, b & 0xFF); break;
      case 'lockOpen':   s.lockClosed = false; s.running = false; s.engMode = false;
                         this._send(P.CMD.LOCK_OPEN, 0, 0); break;
      case 'lockClose':  s.lockClosed = true; this._send(P.CMD.LOCK_CLOSE, 0, 0); break;
      case 'hubReset':   this._send(P.CMD.HUB_RESET, 0, 0); break;
      case 'wakeUp':     this._send(P.CMD.WAKE_UP, 0, 0); break;
      case 'heart':      this._send(P.CMD.HEART, a & 0xFF, 0); break;
      case 'noSpeedFb':  this._send(P.CMD.NO_SPEED_FB, 0, 0); break;
      case 'buzzShort':  this._send(P.CMD.BUZZ_SHORT, 0, 0); break;
      case 'buzzLong':   this._send(P.CMD.BUZZ_LONG, 0, 0); break;
      case 'error':      this._send(a & 0xFF, 0, 0); break;
      case 'engLift':    s.engLift = a & 0xFF; break;
      case 'setMode':    s.mode = a; break;
      case 'garbage':    // 注入雜訊，測試解析器重新同步能力
        if (this.io && this.io.send) {
          this.io.send(new Uint8Array([0x12, 0x34, 0xAA, 0xBB, 0x01, 0x64, 0x05, 0x00]));
        }
        break;
      default: break;
    }
  };

  global.SimDevice = SimDevice;
})(window);
