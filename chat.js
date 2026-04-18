'use strict';

const Swarm  = require('./index');
const crypto = require('crypto');
const rl     = require('readline');
const fs     = require('fs');

const nick = process.argv[2];
const room = process.argv[3] || 'geral';

if (!nick) {
  console.error('Uso: node chat.js <nick> [sala]');
  process.exit(1);
}

const SEED_FILE = './identity.json';
let seed;
if (fs.existsSync(SEED_FILE)) {
  seed = JSON.parse(fs.readFileSync(SEED_FILE)).seed;
} else {
  seed = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SEED_FILE, JSON.stringify({ seed }));
}

const iface = rl.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let closing = false;

function clearLine() { process.stdout.write('\r\x1b[2K'); }

function print(line) {
  if (closing || iface.closed) return;
  clearLine();
  console.log(line);
  iface.prompt(true);
}

function ts() {
  const d = new Date();
  return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
}

function logSys(msg) { print(`\x1b[90m[${ts()}] * ${msg}\x1b[0m`); }
function logMsg(from, text) {
  const color = from === nick ? '\x1b[32m' : '\x1b[35m';
  print(`\x1b[90m[${ts()}]\x1b[0m ${color}${from}\x1b[0m: ${text}`);
}

const swarm      = new Swarm({ seed });
const topic      = crypto.createHash('sha256').update('chat:' + room).digest();
const peerNicks  = new Map();
const joinedBack = new Set();

logSys(`iniciando swarm... nick=${nick} sala=${room}`);

swarm.join(topic, { announce: true, lookup: true }).ready().then(() => {
  logSys(`swarm pronto | NAT: ${swarm.natType} | addr: ${swarm.publicAddress || 'LAN'}`);
  logSys(`sala: #${room} — aguardando peers...`);
  iface.prompt(true);
});

swarm.on('nat',     () => logSys(`NAT detectado: ${swarm.natType} | addr: ${swarm.publicAddress || 'LAN'}`));
swarm.on('nattype', () => logSys(`NAT type: ${swarm.natType}`));

swarm.on('connection', (peer) => {
  logSys(`peer conectado: ${peer.id}`);
  peer.write(Buffer.from(JSON.stringify({ type: 'JOIN', nick })));
});

swarm.on('data', (data, peer) => {
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }

  if (msg._selfId && msg._selfId === swarm._id) return;

  if (msg.type === 'JOIN') {
    const isNew = !peerNicks.has(peer.id);
    peerNicks.set(peer.id, msg.nick);
    if (isNew) logSys(`${msg.nick} entrou na sala`);
    if (!joinedBack.has(peer.id)) {
      joinedBack.add(peer.id);
      try { peer.write(Buffer.from(JSON.stringify({ type: 'JOIN', nick }))); } catch {}
    }
  }

  if (msg.type === 'MSG')   logMsg(msg.nick, msg.text);

  if (msg.type === 'LEAVE') {
    logSys(`${peerNicks.get(peer.id) || msg.nick} saiu`);
    peerNicks.delete(peer.id);
  }
});

swarm.on('disconnect', (peerId) => {
  logSys(`peer desconectado: ${peerNicks.get(peerId) || peerId.slice(0, 8)}`);
  peerNicks.delete(peerId);
  joinedBack.delete(peerId);
});

iface.setPrompt(`\x1b[32m${nick}\x1b[0m > `);

iface.on('line', (line) => {
  const text = line.trim();
  if (!text) { iface.prompt(true); return; }

  if (text === '/peers') {
    logSys(`peers: ${swarm.size}`);
    swarm.peers.forEach(p => {
      const n = peerNicks.get(p.id) || '?';
      logSys(`  ${p.id.slice(0, 8)} nick=${n} rtt=${Math.round(p.rtt)}ms session=${!!p._session} mesh=${p.inMesh}`);
    });
    iface.prompt(true);
    return;
  }

  if (text === '/nat') {
    logSys(`NAT: ${swarm.natType} | addr: ${swarm.publicAddress || 'LAN'}`);
    iface.prompt(true);
    return;
  }

  if (text === '/sair' || text === '/quit') {
    closing = true;
    swarm.broadcast(Buffer.from(JSON.stringify({ type: 'LEAVE', nick })));
    setTimeout(() => swarm.destroy().then(() => process.exit(0)), 300);
    return;
  }

  const payload = Buffer.from(JSON.stringify({ type: 'MSG', nick, text, _selfId: swarm._id, _ts: Date.now() }));
  const sent = swarm.broadcast(payload);
  if (!sent && swarm.peers.some(p => p._session)) {
    swarm.peers.forEach(p => { if (p._session) p.write(payload); });
  }
  logMsg(nick, text);
  iface.prompt(true);
});

iface.on('close', () => {
  closing = true;
  swarm.broadcast(Buffer.from(JSON.stringify({ type: 'LEAVE', nick })));
  swarm.destroy().then(() => process.exit(0));
});

setTimeout(() => logSys('comandos: /peers  /nat  /sair'), 500);
