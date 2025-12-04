const { db, admin } = require('./firestore-service');
const { sortearTimes, assignRolesForTeams } = require('./matchmaking-logic');

const QUEUE_COLLECTION = 'queuee';
const READY_COLLECTION = 'aguardandoPartidas';
const HISTORICO_COLLECTION = 'Historico';
const READY_DURATION_MS = 30000;

let processingQueue = false;

async function checkQueueForMatchmaking() {
  try {
    if (processingQueue) return;
    const qsnap = await db.collection(QUEUE_COLLECTION).orderBy('timestamp', 'asc').limit(10).get();
    const players = qsnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (players.length < 10) return;
    processingQueue = true;
    try { await createReadyCheckWithFirst10(players) } finally { processingQueue = false }
  } catch {}
}

async function createReadyCheckWithFirst10(queuePlayers) {
  const first10 = queuePlayers.slice(0, 10);
  const readyRef = db.collection(READY_COLLECTION).doc();
  await db.runTransaction(async (tx) => {
    const queueDocs = first10.map((p) => db.collection(QUEUE_COLLECTION).doc(p.id));
    const docs = await Promise.all(queueDocs.map((r) => tx.get(r)));
    if (docs.some((d) => !d.exists)) throw new Error('Fila alterada');
    let players = docs.map((d) => ({ id: d.id, ...d.data() }));
    players = await enrichPlayers(players);
    const acc = {};
    players.forEach((p) => { acc[p.uid] = p.source === 'manual' ? 'accepted' : 'pending'; });
    const uids = players.map((p) => p.uid);
    const times = assignRolesForTeams(sortearTimes(players));
    tx.set(readyRef, {
      status: 'pending',
      timestampFim: new Date(Date.now() + READY_DURATION_MS),
      jogadores: players,
      playerAcceptances: acc,
      uids,
      times,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    queueDocs.forEach((r) => tx.delete(r));
  });
}

function nowMs() { return Date.now(); }

async function checkPendingReadyChecks() {
  try {
    const qsnap = await db.collection(READY_COLLECTION).where('status','in',['pending','readyCheck']).get();
    for (const d of qsnap.docs) {
      const data = d.data();
      await maybeResolveReadyDoc(d.id, data);
    }
  } catch {}
}

async function maybeResolveReadyDoc(id, data) {
  const docRef = db.collection(READY_COLLECTION).doc(id);
  const endMs = data.timestampFim?.toMillis ? data.timestampFim.toMillis() : new Date(data.timestampFim).getTime();
  const acc = data.playerAcceptances || {};
  const vals = Object.values(acc);
  const expired = nowMs() >= endMs;
  const acceptedCount = vals.filter(v => v === 'accepted').length;
  const declinedCount = vals.filter(v => v === 'declined').length;
  const pendingCount = vals.filter(v => v === 'pending').length;
  const allAccepted = vals.length === 10 && acceptedCount === 10;
  // Apenas resolve por recusa se alguém tiver recusado explicitamente
  if (declinedCount > 0) {
    await db.runTransaction(async (tx) => { tx.update(docRef, { status: 'declined' }); });
    await punishAndReturn(id, data, 'declined');
    await docRef.delete();
    return;
  }
  // Timeout somente após expirar; enquanto houver pendentes e não expirou, mantém readyCheck
  if (expired) {
    await db.runTransaction(async (tx) => { tx.update(docRef, { status: 'timeout' }); });
    await punishAndReturn(id, data, 'timeout');
    await docRef.delete();
    return;
  }
  if (allAccepted) {
    await db.runTransaction(async (tx) => { tx.update(docRef, { status: 'accepted' }); });
    await createMatchFromReady(id, data);
    await docRef.delete();
  }
}

async function punishAndReturn(id, data, mode) {
  const acc = data.playerAcceptances || {};
  const acceptedUids = Object.keys(acc).filter((uid) => acc[uid] === 'accepted');
  const pendingUids = Object.keys(acc).filter((uid) => acc[uid] === 'pending');
  const declinedUids = Object.keys(acc).filter((uid) => acc[uid] === 'declined');
  const toPunish = mode === 'declined' ? declinedUids : [...pendingUids, ...declinedUids];
  const reAdd = mode === 'declined' ? [...acceptedUids, ...pendingUids] : acceptedUids;
  const banUntil = new Date(Date.now() + 30 * 1000);
  await Promise.all(
    toPunish.map((uid) => db.collection('users').doc(uid).update({ penaltyUntil: banUntil, matchmakingBanUntil: banUntil, banReason: mode === 'declined' ? 'Recusa de Ready Check' : 'Timeout de Ready Check' }))
  );
  await Promise.all(
    toPunish.map(async (uid) => {
      const q = await db.collection(QUEUE_COLLECTION).where('uid', '==', uid).get();
      const dels = q.docs.map((d) => db.collection(QUEUE_COLLECTION).doc(d.id).delete());
      await Promise.all(dels);
    })
  );
  const byUid = {}; (data.jogadores || []).forEach((p) => (byUid[p.uid] = p));
  await Promise.all(
    reAdd.map(async (uid) => {
      const p = byUid[uid]; if (!p || p.source === 'manual') return;
      const usnap = await db.collection('users').doc(uid).get();
      const ud = usnap.exists ? usnap.data() : {};
      const nome = (p.nome || ud.nome || ud.playerName || uid);
      const elo = p.elo || ud.elo || 'Ferro';
      const divisao = p.divisao || ud.divisao || 'IV';
      const rolePrincipal = p.rolePrincipal || ud.rolePrincipal || 'Preencher';
      const roleSecundaria = p.roleSecundaria || ud.roleSecundaria || 'Preencher';
      const tag = p.tag || ud.tag || '';
      const payload = { uid, nome, elo, divisao, rolePrincipal, roleSecundaria, tag, source: 'queuee', timestamp: admin.firestore.FieldValue.serverTimestamp() };
      await db.collection(QUEUE_COLLECTION).doc(uid).set(payload);
    })
  );
}

async function createMatchFromReady(id, data) {
  const times = data.times || { time1: { jogadores: [] }, time2: { jogadores: [] } };
  const time1 = times.time1 || { jogadores: [], pontuacao: 0, nome: 'Time Azul' };
  const time2 = times.time2 || { jogadores: [], pontuacao: 0, nome: 'Time Vermelho' };
  const partida = {
    data: new Date().toISOString(),
    time1,
    time2,
    vencedor: 'N/A',
    isRandom: false,
    pontuacaoDiferenca: Math.abs((time1.pontuacao || 0) - (time2.pontuacao || 0)),
    status: 'Aberta',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    readyDocId: id
  };
  await db.collection(HISTORICO_COLLECTION).add(partida);
  const uids = Array.isArray(data.uids) ? data.uids : (data.jogadores || []).map(p => p.uid).filter(Boolean);
  await Promise.all(uids.map(async (uid) => {
    const q = await db.collection(QUEUE_COLLECTION).where('uid','==',uid).get();
    const dels = q.docs.map(d => db.collection(QUEUE_COLLECTION).doc(d.id).delete());
    await Promise.all(dels);
  }));
}

async function enrichPlayers(players) {
  const usersCol = db.collection('users');
  const enriched = await Promise.all(players.map(async (p) => {
    let u = null;
    if (p.uid) {
      const snap = await usersCol.doc(p.uid).get();
      u = snap.exists ? snap.data() : null;
    }
    
    const nome = p.nome || (u && (u.nome || u.playerName)) || '';
    const elo = p.elo || (u && u.elo) || 'Ferro';
    const divisao = p.divisao || (u && u.divisao) || 'IV';
    const rolePrincipal = p.rolePrincipal || u?.rolePrincipal || 'Preencher';
    const roleSecundaria = p.roleSecundaria || u?.roleSecundaria || 'Preencher';
    const tag = u?.tag || p.tag || '';
    return { ...p, nome, elo, divisao, rolePrincipal, roleSecundaria, tag };
  }));
  return enriched;
}

async function main() {
  setInterval(checkQueueForMatchmaking, 5000);
  setInterval(checkPendingReadyChecks, 5000);
}

main();
