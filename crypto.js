'use strict';

const crypto = require('crypto');
const { TAG_LEN, NONCE_LEN } = require('./constants');

function generateX25519(seed) {
  if (seed) {

const seedBuf = typeof seed === 'string' ? Buffer.from(seed, 'hex') : seed;
    const derived = crypto.createHash('sha256').update(seedBuf).digest();
    const privateKey = crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), derived]),
      format: 'der', type: 'pkcs8'
    });
    const publicKey = crypto.createPublicKey(privateKey);
    const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
    return { privateKey, pubRaw };
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
  return { privateKey, pubRaw };
}

function deriveSession(myPriv, theirPubRaw) {
  const spki = Buffer.concat([
    Buffer.from('302a300506032b656e032100', 'hex'),
    theirPubRaw,
  ]);
  const theirPub = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const shared   = crypto.diffieHellman({ privateKey: myPriv, publicKey: theirPub });
  const derived  = Buffer.from(
    crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from('p2p-v12-session'), 68)
  );
  return {
    sendKey:   derived.slice(0, 32),
    recvKey:   derived.slice(32, 64),
    sessionId: derived.readUInt32BE(64),
    sendCtr:   0n,
  };
}

function encrypt(sess, plaintext) {
  const nonce = Buffer.allocUnsafe(NONCE_LEN);
  nonce.writeUInt32BE(sess.sessionId, 0);
  nonce.writeBigUInt64BE(sess.sendCtr, 4);
  sess.sendCtr++;
  const cipher = crypto.createCipheriv('chacha20-poly1305', sess.sendKey, nonce, { authTagLength: TAG_LEN });
  const ct  = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]);
}

function decrypt(sess, buf) {
  if (buf.length < NONCE_LEN + TAG_LEN) return null;
  const nonce      = buf.slice(0, NONCE_LEN);
  const tag        = buf.slice(buf.length - TAG_LEN);
  const ciphertext = buf.slice(NONCE_LEN, buf.length - TAG_LEN);
  try {
    const decipher = crypto.createDecipheriv('chacha20-poly1305', sess.recvKey, nonce, { authTagLength: TAG_LEN });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch { return null; }
}

module.exports = { generateX25519, deriveSession, encrypt, decrypt };
