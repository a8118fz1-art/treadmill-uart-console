/*
 * serial.js — UART 連線層
 * 提供統一的 LINK 介面，後端可切換為 Web Serial 實體串列埠或內建模擬器。
 */
(function (global) {
  'use strict';

  function nowMs() { return Date.now(); }

  // ── Web Serial 後端 ────────────────────────────────────────
  function SerialBackend() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.readLoop = null;
    this.closing = false;
  }

  SerialBackend.isSupported = function () {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  };

  SerialBackend.prototype.requestPort = function () {
    return navigator.serial.requestPort();
  };

  SerialBackend.prototype.open = function (opts, onData, onClose) {
    var self = this;
    this.closing = false;
    var port = opts.port;

    return port.open({
      baudRate: opts.baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      bufferSize: 1024
    }).then(function () {
      self.port = port;
      self.writer = port.writable.getWriter();
      self.readLoop = self._read(onData, onClose);
      return port.getInfo ? port.getInfo() : {};
    });
  };

  SerialBackend.prototype._read = function (onData, onClose) {
    var self = this;
    return (async function () {
      try {
        while (self.port && self.port.readable && !self.closing) {
          self.reader = self.port.readable.getReader();
          try {
            while (true) {
              var res = await self.reader.read();
              if (res.done) break;
              if (res.value && res.value.length) onData(res.value);
            }
          } catch (err) {
            if (!self.closing) onClose('讀取錯誤：' + (err && err.message ? err.message : err));
            break;
          } finally {
            try { self.reader.releaseLock(); } catch (e) {}
            self.reader = null;
          }
        }
      } finally {
        if (!self.closing) onClose('連線中斷');
      }
    })();
  };

  SerialBackend.prototype.write = function (bytes) {
    if (!this.writer) return Promise.reject(new Error('尚未連線'));
    return this.writer.write(bytes);
  };

  SerialBackend.prototype.close = function () {
    var self = this;
    this.closing = true;
    var chain = Promise.resolve();
    if (this.reader) {
      chain = chain.then(function () { return self.reader.cancel().catch(function () {}); });
    }
    return chain
      .then(function () { return self.readLoop; })
      .catch(function () {})
      .then(function () {
        if (self.writer) {
          try { self.writer.releaseLock(); } catch (e) {}
          self.writer = null;
        }
        if (self.port) {
          var p = self.port;
          self.port = null;
          return p.close().catch(function () {});
        }
      });
  };

  // ── 模擬器後端（無硬體時開發用） ──────────────────────────
  function SimBackend() {
    this.device = null;
  }

  SimBackend.prototype.open = function (opts, onData) {
    this.device = new global.SimDevice({
      send: function (bytes) { onData(bytes); }
    });
    this.device.start();
    return Promise.resolve({ simulated: true });
  };

  SimBackend.prototype.write = function (bytes) {
    if (this.device) this.device.receive(bytes);
    return Promise.resolve();
  };

  SimBackend.prototype.close = function () {
    if (this.device) { this.device.stop(); this.device = null; }
    return Promise.resolve();
  };

  // ── LINK：對外統一介面 ────────────────────────────────────
  var LINK = {
    backend: null,
    kind: null,          // 'serial' | 'sim'
    connected: false,
    baudRate: 9600,
    stats: { tx: 0, rx: 0, txBytes: 0, rxBytes: 0, badSum: 0, noise: 0, lastRxAt: 0 },
    handlers: { onData: function () {}, onStatus: function () {} },

    isSerialSupported: SerialBackend.isSupported,

    on: function (name, fn) { this.handlers[name] = fn; return this; },

    _status: function (state, msg) { this.handlers.onStatus(state, msg); },

    /** 讓使用者挑選串列埠（需由使用者手勢觸發） */
    pickPort: function () {
      if (!SerialBackend.isSupported()) {
        return Promise.reject(new Error('此瀏覽器不支援 Web Serial API，請改用 Chrome / Edge 桌面版'));
      }
      return navigator.serial.requestPort();
    },

    connect: function (opts) {
      var self = this;
      if (this.connected) return Promise.resolve();
      opts = opts || {};
      this.kind = opts.simulate ? 'sim' : 'serial';
      this.baudRate = opts.baudRate || 9600;
      this.backend = this.kind === 'sim' ? new SimBackend() : new SerialBackend();
      this.stats = { tx: 0, rx: 0, txBytes: 0, rxBytes: 0, badSum: 0, noise: 0, lastRxAt: 0 };

      return this.backend.open(
        { port: opts.port, baudRate: this.baudRate },
        function (bytes) {
          self.stats.rxBytes += bytes.length;
          self.stats.lastRxAt = nowMs();
          self.handlers.onData(bytes);
        },
        function (reason) { self._onBackendClosed(reason); }
      ).then(function (info) {
        self.connected = true;
        self._status('connected', self.kind === 'sim' ? '模擬器已連線' : '已連線 @ ' + self.baudRate + " bps");
        return info;
      }).catch(function (err) {
        self.backend = null;
        self.connected = false;
        self._status('error', err && err.message ? err.message : String(err));
        throw err;
      });
    },

    _onBackendClosed: function (reason) {
      if (!this.connected) return;
      this.connected = false;
      this.backend = null;
      this._status('disconnected', reason || '已離線');
    },

    disconnect: function () {
      var self = this;
      if (!this.backend) { this.connected = false; return Promise.resolve(); }
      var b = this.backend;
      this.connected = false;
      this.backend = null;
      return b.close().then(function () { self._status('disconnected', '已離線'); });
    },

    /** 送出原始位元組 */
    send: function (bytes) {
      if (!this.connected || !this.backend) return Promise.reject(new Error('尚未連線'));
      this.stats.tx++;
      this.stats.txBytes += bytes.length;
      return this.backend.write(bytes);
    },

    /** 取得模擬裝置（僅模擬模式） */
    sim: function () {
      return this.backend && this.backend.device ? this.backend.device : null;
    }
  };

  global.LINK = LINK;
})(window);
