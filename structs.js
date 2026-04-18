'use strict';

const { BLOOM_BITS, BLOOM_HASHES, BLOOM_ROTATE } = require('./constants');

class BloomFilter {
  constructor(bits, numHashes) {
    this._bits   = bits       || BLOOM_BITS;
    this._hashes = numHashes  || BLOOM_HASHES;
    this._cur    = Buffer.alloc(this._bits >> 3);
    this._old    = Buffer.alloc(this._bits >> 3);
    this._count  = 0;
    this._lastRotate = Date.now();
  }

  _rotate() {
    if (Date.now() - this._lastRotate < BLOOM_ROTATE) return;
    this._old  = this._cur;
    this._cur  = Buffer.alloc(this._bits >> 3);
    this._count = 0;
    this._lastRotate = Date.now();
  }

  _positions(key) {
    const out = [];
    for (let i = 0; i < this._hashes; i++) {
      let h = (2166136261 + i * 16777619) >>> 0;
      for (let j = 0; j < key.length; j++) {
        h ^= (typeof key === 'string' ? key.charCodeAt(j) : key[j]);
        h  = Math.imul(h, 16777619) >>> 0;
      }
      out.push(h % this._bits);
    }
    return out;
  }

  add(key) {
    this._rotate();
    for (const pos of this._positions(key))
      this._cur[pos >> 3] |= (1 << (pos & 7));
    this._count++;
  }

  has(key) {
    const pos = this._positions(key);
    const inCur = pos.every(p => this._cur[p >> 3] & (1 << (p & 7)));
    if (inCur) return true;
    return pos.every(p => this._old[p >> 3] & (1 << (p & 7)));
  }

  seen(key) { if (this.has(key)) return true; this.add(key); return false; }
}

class LRU {
  constructor(max, ttl) {
    this._m   = new Map();
    this._max = max;
    this._ttl = ttl || Infinity;
  }

  has(k) { return this._m.has(k); }

  add(k, v) {
    const now = Date.now();
    if (this._ttl < Infinity) {
      let n = 0;
      for (const [key, entry] of this._m) {
        if (n++ > 300) break;
        if (now - entry.t > this._ttl) this._m.delete(key);
      }
    }
    if (this._m.size >= this._max) this._m.delete(this._m.keys().next().value);
    this._m.set(k, { v, t: now });
  }

  get(k) { const e = this._m.get(k); return e ? e.v : undefined; }
  seen(k) { if (this.has(k)) return true; this.add(k, 1); return false; }
  delete(k) { this._m.delete(k); }
  get size() { return this._m.size; }
  keys() { return this._m.keys(); }
  entries() { return [...this._m.entries()].map(([k, e]) => [k, e.v]); }
}

class RingBuffer {
  constructor(size) {
    if ((size & (size - 1)) !== 0) throw new RangeError(`RingBuffer: size must be a power of 2, got ${size}`);
    this._buf  = new Array(size);
    this._mask = size - 1;
    this._head = 0;
    this._tail = 0;
  }

  get length() { return (this._tail - this._head) & this._mask; }
  get full()   { return ((this._tail + 1) & this._mask) === (this._head & this._mask); }
  get empty()  { return this._head === this._tail; }

  push(item) {
    if (this.full) this._head = (this._head + 1) & this._mask;
    this._buf[this._tail] = item;
    this._tail = (this._tail + 1) & this._mask;
  }

  shift() {
    if (this.empty) return undefined;
    const item = this._buf[this._head];
    this._buf[this._head] = null;
    this._head = (this._head + 1) & this._mask;
    return item;
  }

  clear() { this._head = 0; this._tail = 0; }
}

class PayloadCache {
  constructor(size) {
    this._keys = new Array(size);
    this._vals = new Array(size);
    this._map  = new Map();
    this._mask = size - 1;
    this._head = 0;
  }

  set(msgId, frame) {
    const old = this._keys[this._head];
    if (old) this._map.delete(old);
    this._keys[this._head] = msgId;
    this._vals[this._head] = frame;
    this._map.set(msgId, this._head);
    this._head = (this._head + 1) & this._mask;
  }

  get(msgId) {
    const idx = this._map.get(msgId);
    return idx !== undefined ? this._vals[idx] : null;
  }

  has(msgId) { return this._map.has(msgId); }
}

module.exports = { BloomFilter, LRU, RingBuffer, PayloadCache };
