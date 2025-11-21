const { db, admin } = require('./firestore-service');
const { sortearTimes } = require('./matchmaking-logic');

const QUEUE_COLLECTION = 'queue';
const READY_COLLECTION = 'aguardandoPartidas';
const HISTORICO_COLLECTION = 'historicoPartidas';
const READY_DURATION_MS = 30000;

let processingQueue = false;

async function startQueueListener() {
  const queueRef = db.collection(QUEUE_COLLECTION);
  queueRef.orderBy('timestamp', 'asc').onSnapshot(async (snap) => {
    try {
      const players = [];
      snap.forEach((d) => players.push({ id: d.id, ...d.data() }));
      if (players.length >= 10 && !processingQueue) {
        processingQueue = true;
        await createReadyCheckWithFirst10(players);
        processingQueue = false;
      }
    } catch (_) {
      processingQueue = false;
    }
  });
}

async function createReadyCheckWithFirst10(queuePlayers) {
  const first10 = queuePlayers.slice(0, 10);
  const readyRef = db.collection(READY_COLLECTION).doc();
  await db.runTransaction(async (tx) => {
    const queueDocs = first10.map((p) => db.collection(QUEUE_COLLECTION).doc(p.id));
    const docs = await Promise.all(queueDocs.map((r) => tx.get(r)));
    if (docs.some((d) => !d.exists)) throw new Error('Fila alterada');
    const players = docs.map((d) => ({ id: d.id, ...d.data() }));
    const acc = {};
    players.forEach((p) => { acc[p.uid] = p.source === 'manual' ? 'accepted' : 'pending'; });
    const uids = players.map((p) => p.uid);
    const times = sortearTimes(players);
    tx.set(readyRef, {
      status: 'readyCheck',
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

async function startReadyListener() {
  const ref = db.collection(READY_COLLECTION);
  ref.onSnapshot(async (snap) => {
    const docs = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    for (const { id, data } of docs) {
      if (data.status !== 'readyCheck') continue;
      await maybeResolveReadyDoc(id, data);
    }
  });
}

async function maybeResolveReadyDoc(id, data) {
  const docRef = db.collection(READY_COLLECTION).doc(id);
  const endMs = data.timestampFim?.toMillis ? data.timestampFim.toMillis() : new Date(data.timestampFim).getTime();
  const acc = data.playerAcceptances || {};
  const vals = Object.values(acc);
  const expired = nowMs() >= endMs;
  const allAccepted = vals.length === 10 && vals.every((v) => v === 'accepted');
  const anyDeclined = vals.some((v) => v === 'declined' || v === 'timeout');
  if (expired || anyDeclined) {
    const statusFinal = expired ? 'timeout' : 'declined';
    await db.runTransaction(async (tx) => { tx.update(docRef, { status: statusFinal }); });
    await punishAndReturn(id, data, statusFinal);
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
  const penalizeStatuses = mode === 'declined' ? ['declined'] : ['declined', 'pending'];
  const toPunish = Object.keys(acc).filter((uid) => penalizeStatuses.includes(acc[uid]));
  const banUntil = new Date(Date.now() + 5 * 60 * 1000);
  await Promise.all(
    toPunish.map((uid) => db.collection('users').doc(uid).update({ matchmakingBanUntil: banUntil, banReason: mode === 'declined' ? 'Recusa de Ready Check' : 'Timeout de Ready Check' }))
  );
  const byUid = {}; (data.jogadores || []).forEach((p) => (byUid[p.uid] = p));
  await Promise.all(
    acceptedUids.map((uid) => {
      const p = byUid[uid]; if (!p || p.source === 'manual') return Promise.resolve();
      const payload = { uid: p.uid, nome: p.nome, elo: p.elo, divisao: p.divisao, rolePrincipal: p.rolePrincipal, roleSecundaria: p.roleSecundaria, tag: p.tag || '', source: 'queue', timestamp: admin.firestore.FieldValue.serverTimestamp() };
      return db.collection(QUEUE_COLLECTION).add(payload);
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
}

async function main() {
  await startQueueListener();
  await startReadyListener();
}

main();