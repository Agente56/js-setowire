'use strict';

const EventEmitter = require('events');
const { RingBuffer }                             = require('./structs');
const { FragmentAssembler, JitterBuffer, xorHash, fragmentPayload } = require('./framing');
const { encrypt }                                = require('./crypto');
const {
  RTT_INIT, QUEUE_CTRL, QUEUE_DATA,
  CWND_INIT, CWND_MAX, CWND_DECAY,
  RATE_PER_SEC, RATE_BURST,
  MAX_ADDRS_PEER, F_DATA, F_FRAG,
} = require('./constants');

class Peer extends EventEmitter {
  constructor(swarm, id, addr) {
    super();
    this.id            = id;
    this.remoteAddress = addr;
    this._swarm        = swarm;
    this._addrs        = new Map(); 
    this._addrs.set(addr, RTT_INIT);
    this._best         = addr;
    this._seen         = Date.now();
    this._open         = true;
    this.inMesh        = false;
    this._meshTime     = 0;
    this.score         = 0;
    this.rtt           = RTT_INIT;
    this.bandwidth     = 0;   

this._session     = null;
    this._theirPubRaw = null;

this._ctrlQueue = new RingBuffer(QUEUE_CTRL);
    this._dataQueue = new RingBuffer(QUEUE_DATA);
    this._draining  = false;

this._fragger = new FragmentAssembler();

this._sendSeq = 0;
    this._jitter  = new JitterBuffer(plain => {
      const msgKey = xorHash(plain);
      if (this._swarm._bloom.seen(msgKey)) return;
      this.emit('data', plain);
      this._swarm.emit('data', plain, this);
      this._swarm._floodMesh(plain, this.id);
    });

this._cwnd     = CWND_INIT;
    this._inflight = 0;
    this._lastLoss = 0;

this._tokens   = RATE_BURST;
    this._lastRate = Date.now();

this._lastPingSent = 0;
    this._lastPong     = Date.now();
    this._bytesSent    = 0;
    this._bytesWindow  = Date.now();
  }

writeCtrl(data) {
    if (!this._open) return false;
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this._ctrlQueue.push(raw);
    if (!this._draining) setImmediate(() => this._drain());
    return true;
  }

  write(data) {
    if (!this._open || !this._session) return false;
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this._dataQueue.push(raw);
    if (!this._draining) setImmediate(() => this._drain());
    return true;
  }

  _enqueue(raw) { this.write(raw); }

_drain() {
    this._draining = true;
    
    while (!this._ctrlQueue.empty) {
      const raw = this._ctrlQueue.shift();
      if (raw) this._sendRaw(raw);
    }
    
    while (!this._dataQueue.empty && this._inflight < this._cwnd) {
      const raw = this._dataQueue.shift();
      if (!raw) break;
      this._sendEncrypted(raw);
    }
    if (!this._dataQueue.empty && this._inflight < this._cwnd)
      setImmediate(() => this._drain());
    this._draining = false;
  }

  _sendEncrypted(plain) {
    if (!this._session) return;

const now   = Date.now();
    const delta = (now - this._lastRate) / 1000;
    this._tokens   = Math.min(RATE_BURST, this._tokens + delta * RATE_PER_SEC);
    this._lastRate = now;
    if (this._tokens < 1) return;
    this._tokens--;

const frags = fragmentPayload(plain);
    if (frags) {
      for (const frag of frags.frags) {
        const wrapped = Buffer.allocUnsafe(1 + frag.length);
        wrapped[0] = F_FRAG;
        frag.copy(wrapped, 1);
        this._sendRaw(wrapped);
      }
      return;
    }

const seqBuf = Buffer.allocUnsafe(4 + plain.length);
    seqBuf.writeUInt32BE(this._sendSeq++, 0);
    plain.copy(seqBuf, 4);

    const ct    = encrypt(this._session, seqBuf);
    const frame = Buffer.allocUnsafe(1 + ct.length);
    frame[0]    = F_DATA;
    ct.copy(frame, 1);
    this._sendRaw(frame);
    this._inflight++;

this._bytesSent += frame.length;
    const elapsed = (Date.now() - this._bytesWindow) / 1000;
    if (elapsed >= 1) {
      this.bandwidth = this._bytesSent / elapsed;
      this._bytesSent   = 0;
      this._bytesWindow = Date.now();
    }
  }

  _sendRaw(buf) {
    
    const [ip, port] = this._best.split(':');
    this._swarm._batch.send(ip, port, buf);
  }

  _sendRawNow(buf) {
    const [ip, port] = this._best.split(':');
    this._swarm._batch.sendNow(ip, port, buf);
  }

  _onAck() {
    if (this._inflight > 0) this._inflight--;
    if (this._cwnd < CWND_MAX) this._cwnd = Math.min(CWND_MAX, this._cwnd + 1);
    if (!this._dataQueue.empty) setImmediate(() => this._drain());
  }

  _onLoss() {
    const now = Date.now();
    if (now - this._lastLoss < 1000) return;
    this._lastLoss = now;
    this._cwnd     = Math.max(1, Math.floor(this._cwnd * CWND_DECAY));
    this._inflight = Math.min(this._inflight, this._cwnd);
  }

_touch(addr, rtt) {
    this._seen        = Date.now();
    this._lastPong    = Date.now();
    this._lossSignaled = false;  
    if (addr) {
      const r = rtt || this.rtt;
      this._addrs.set(addr, r);
      if (this._addrs.size > MAX_ADDRS_PEER) {
        
        let worst = null, worstRtt = -1;
        for (const [a, rt] of this._addrs) {
          if (rt > worstRtt) { worstRtt = rt; worst = a; }
        }
        if (worst && worst !== addr) {
          this._addrs.delete(worst);
          this._swarm._addrToId.delete(worst);
        }
      }
      
      let best = addr, bestRtt = r;
      for (const [a, rt] of this._addrs) {
        if (rt < bestRtt) { bestRtt = rt; best = a; }
      }
      this._best         = best;
      this.remoteAddress = best;
      this._swarm._addrToId.set(addr, this.id);
    }
  }

  _scoreUp(n = 1)   { this.score = Math.min(1000, this.score + n); }
  _scoreDown(n = 2) { this.score = Math.max(-1000, this.score - n); }

  destroy() {
    this._open = false;
    for (const addr of this._addrs.keys()) this._swarm._addrToId.delete(addr);
    this._fragger.clear();
    this._jitter.clear();
    this._ctrlQueue.clear();
    this._dataQueue.clear();
    this.emit('close');
  }
}

module.exports = Peer;
