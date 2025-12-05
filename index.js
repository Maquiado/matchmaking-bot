const { db, FieldValue, Timestamp } = require('./firebase');

let unsub = null;
const timers = new Map();
const processed = new Set();

function start() {
  if (unsub) return;
  unsub = db.collection('aguardandoPartidas').onSnapshot(
    (snap) => {
      snap.docChanges().forEach((chg) => handleChange(chg));
    },
    (err) => { console.error('aguardandoPartidas listener error', err); }
  );
  setInterval(cleanupOldRooms, 10 * 60 * 1000);
}

function handleChange(chg) {
  const id = chg.doc.id;
  if (chg.type === 'removed') { clearTimer(id); processed.delete(id); return; }
  const data = chg.doc.data();
  scheduleTimeout(id, data);
  resolveIfComplete(id, data);
}

function clearTimer(id) {
  const t = timers.get(id);
  if (t) { clearTimeout(t); timers.delete(id); }
}

function scheduleTimeout(id, data) {
  if (!data || data.status !== 'pending') { clearTimer(id); return; }
  const ts = data.timestampFim;
  let endMs = Date.now() + 30000;
  try { endMs = (typeof ts.toDate === 'function' ? ts.toDate().getTime() : new Date(ts).getTime()); } catch (_) {}
  const now = Date.now();
  const delay = Math.max(0, endMs - now);
  clearTimer(id);
  const to = setTimeout(async () => { await markTimeout(id); }, delay);
  timers.set(id, to);
}

async function markTimeout(id) {
  const ref = db.collection('aguardandoPartidas').doc(id);
  await ref.update({ status: 'timeout' });
}

function resolveIfComplete(id, data) {
  if (!data || processed.has(id)) return;
  const acc = data.playerAcceptances || {};
  const vals = Object.values(acc);
  if (!vals.length) return;
  const allAccepted = vals.every((v) => v === 'accepted');
  const anyDeclined = vals.some((v) => v === 'declined');
  if (data.status === 'accepted' || allAccepted) { finalizeAccepted(id, data); return; }
  if (data.status === 'declined' || anyDeclined) { finalizeDeclinedOrTimeout(id, data, 'declined'); return; }
  if (data.status === 'timeout') { finalizeDeclinedOrTimeout(id, data, 'timeout'); return; }
}

async function finalizeAccepted(id, data) {
  if (processed.has(id)) return;
  processed.add(id);
  const histRef = db.collection('Historico').doc(id);
  const docRef = db.collection('aguardandoPartidas').doc(id);
  await db.runTransaction(async (tx) => {
    const cur = await tx.get(docRef);
    if (!cur.exists) return;
    const d = cur.data();
    const t1 = (d.times && d.times.time1 && d.times.time1.jogadores) || [];
    const t2 = (d.times && d.times.time2 && d.times.time2.jogadores) || [];
    const mapJogador = (j) => ({ uid: j.uid || j.id || null, isLider: !!j.isLider, roleAtribuida: j.roleAtribuida || 'Preencher' });
    const payload = {
      status: 'pendente',
      vencedor: 'N/A',
      random: !!d.random,
      pontuacaoDiferenca: 0,
      time1: { jogadores: t1.map(mapJogador) },
      time2: { jogadores: t2.map(mapJogador) },
      uids: Array.isArray(d.uids) ? d.uids : [],
      createdAt: FieldValue.serverTimestamp()
    };
    tx.set(histRef, payload);
    tx.delete(docRef);
  });
}

async function finalizeDeclinedOrTimeout(id, data, reason) {
  if (processed.has(id)) return;
  processed.add(id);
  const docRef = db.collection('aguardandoPartidas').doc(id);
  const acc = data.playerAcceptances || {};
  const penalizeStatuses = reason === 'declined' ? ['declined'] : ['declined', 'pending'];
  const toPunish = Object.keys(acc).filter((u) => penalizeStatuses.includes(acc[u]));
  const acceptedUids = Object.keys(acc).filter((u) => acc[u] === 'accepted');
  const byUid = {};
  (Array.isArray(data.jogadores) ? data.jogadores : []).forEach((p) => { if (p && p.uid) byUid[p.uid] = p; });
  const banUntil = new Date(Date.now() + 30 * 1000);
  const batch = db.batch();
  toPunish.forEach((u) => {
    const uref = db.collection('users').doc(u);
    batch.update(uref, { matchmakingBanUntil: Timestamp.fromDate(banUntil), banReason: reason === 'declined' ? 'Recusa de Ready Check' : 'Timeout de Ready Check' });
  });
  acceptedUids.forEach((u) => {
    const p = byUid[u];
    if (!p) return;
    const isManual = p.tipo === 'manual' || p.source === 'manual';
    if (isManual) return;
    const qref = db.collection('queue').doc(u);
    const payload = { uid: p.uid, nome: p.nome || '', elo: p.elo || 'Ferro', divisao: p.divisao || 'IV', rolePrincipal: p.rolePrincipal || 'Preencher', roleSecundaria: p.roleSecundaria || 'Preencher', tag: p.tag || '', source: 'queue', tipo: 'automatica', timestamp: FieldValue.serverTimestamp() };
    batch.set(qref, payload, { merge: true });
  });
  batch.delete(docRef);
  await batch.commit();
}

async function cleanupOldRooms() {
  const cutoff = Timestamp.fromDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const snap = await db.collection('aguardandoPartidas').where('createdAt', '<', cutoff).limit(50).get();
  if (snap.empty) return;
  const batch = db.batch();
  snap.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}

start();
