const ELO_BASE = {
  Unranked: 100,
  Ferro: 200,
  Bronze: 400,
  Prata: 600,
  Ouro: 800,
  Esmeralda: 1150,
  Platina: 1300,
  Diamante: 1600,
  Mestre: 1900,
  'Grão-Mestre': 2200,
  Desafiante: 2500
};

const DIVISAO_FATOR = { IV: 1.0, III: 1.1, II: 1.2, I: 1.3 };

function calcularPontuacao(elo, divisao) {
  const base = ELO_BASE[elo] || 0;
  if (base >= ELO_BASE.Diamante) return base;
  const fator = DIVISAO_FATOR[divisao] || 1.0;
  return Math.round(base * fator);
}

function sortearTimes(jogadores) {
  const ordenados = [...jogadores].sort((a, b) => (ELO_BASE[b.elo] || 0) - (ELO_BASE[a.elo] || 0));
  const time1 = [];
  const time2 = [];
  ordenados.forEach((p, i) => (i % 2 === 0 ? time1 : time2).push(p));
  const p1 = time1.reduce((acc, p) => acc + calcularPontuacao(p.elo, p.divisao), 0);
  const p2 = time2.reduce((acc, p) => acc + calcularPontuacao(p.elo, p.divisao), 0);
  return { time1: { jogadores: time1, pontuacao: p1, nome: 'Time Azul' }, time2: { jogadores: time2, pontuacao: p2, nome: 'Time Vermelho' } };
}

module.exports = { calcularPontuacao, sortearTimes };
function assignRole(jogador, team) {
  const rolesUsed = new Set(team.map(j => j.roleAtribuida).filter(r => r !== 'Preencher'));
  const ALL_ROLES = ['Topo', 'Caçador', 'Meio', 'Atirador', 'Suporte'];
  const availableRoles = ALL_ROLES.filter(role => !rolesUsed.has(role));
  let roleToAssign = 'Preencher';
  if (availableRoles.includes(jogador.rolePrincipal)) {
    roleToAssign = jogador.rolePrincipal;
  } else if (availableRoles.includes(jogador.roleSecundaria)) {
    roleToAssign = jogador.roleSecundaria;
  } else if (availableRoles.length > 0) {
    roleToAssign = availableRoles[0];
  }
  if (rolesUsed.size >= 5 && !rolesUsed.has(roleToAssign)) {
    roleToAssign = 'Preencher';
  }
  jogador.roleAtribuida = roleToAssign;
  return jogador;
}

function assignRolesForTeams(times) {
  const t1 = [];
  const t2 = [];
  (times.time1.jogadores || []).forEach(j => { t1.push(assignRole(j, t1)); });
  (times.time2.jogadores || []).forEach(j => { t2.push(assignRole(j, t2)); });
  times.time1.jogadores = t1;
  times.time2.jogadores = t2;
  return times;
}

module.exports.assignRole = assignRole;
module.exports.assignRolesForTeams = assignRolesForTeams;