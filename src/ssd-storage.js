(function (root) {
  'use strict';
  const ns = root.__ALBOT_INTERNALS__;
  if (!ns) throw new Error('ALBOT_INTERNALS_MISSING');

  class HostDurableStorageClient {
    constructor(options = {}) {
      this.root = options.root || root;
      this.endpoint = 'http://127.0.0.1:17391/v1/storage';
      this.requestTimeoutMs = Math.max(500, Math.min(10000, Number(options.requestTimeoutMs) || 3500));
    }

    async _request(method, key, payload = null) {
      if (typeof key !== 'string' || !key.startsWith('albot:')) throw new Error('SSD_KEY_INVALID');
      const fetchFn = this.root && this.root.fetch;
      if (typeof fetchFn !== 'function') throw new Error('SSD_HOST_FETCH_UNAVAILABLE');
      const Ctor = this.root.AbortController;
      const controller = typeof Ctor === 'function' ? new Ctor() : null;
      const timer = controller && typeof this.root.setTimeout === 'function'
        ? this.root.setTimeout(() => controller.abort(), this.requestTimeoutMs)
        : null;
      try {
        const url = this.endpoint + '?key=' + encodeURIComponent(key);
        const request = {
          method, cache: 'no-store', credentials: 'omit',
          ...(payload == null ? {} : {
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            body: JSON.stringify(payload)
          }),
          ...(controller ? { signal: controller.signal } : {})
        };
        const response = await fetchFn.call(this.root, url, request);
        if (!response || response.ok !== true) {
          throw new Error('SSD_HOST_HTTP_' + String(response && response.status || 'FAILED'));
        }
        const data = await response.json();
        if (!data || data.ok !== true) throw new Error('SSD_HOST_RESPONSE_INVALID');
        return data;
      } finally {
        if (timer != null && typeof this.root.clearTimeout === 'function') this.root.clearTimeout(timer);
      }
    }

    async read(key) { return this._request('GET', key); }
    async write(key, value, options = {}) {
      return this._request('POST', key, { key, value, ...options });
    }
    async remove(key) { return this._request('DELETE', key); }
  }

  ns.HostDurableStorageClient = HostDurableStorageClient;
})(typeof globalThis !== 'undefined' ? globalThis : this);
