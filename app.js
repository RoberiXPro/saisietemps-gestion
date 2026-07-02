// SaisieTemps Gestion V49 Firebase Ready
const firebaseConfig = {
  apiKey: "AIzaSyB9r85O9HLeCjjiDbQB75Qw8FZqfPq8bDA",
  authDomain: "saisietemps-gestion.firebaseapp.com",
  projectId: "saisietemps-gestion",
  storageBucket: "saisietemps-gestion.firebasestorage.app",
  messagingSenderId: "313437199588",
  appId: "1:313437199588:web:53400d90c182bac2df20f1"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(e => console.warn('Persistence Auth locale non disponible', e));
const db = firebase.firestore();
let saveTimer = null;
let cloudUnsubscribe = null;
let applyingRemoteState = false;
let lastLocalWriteAt = 0;
let loginInProgress = false;
function currentUserRef(){
  const u = auth.currentUser;
  if(!u) return null;
  return db.collection('saisieTempsUsers').doc(u.uid);
}

function subscribeCloudState(agent){
  if (cloudUnsubscribe) { cloudUnsubscribe(); cloudUnsubscribe = null; }
  const ref = currentUserRef();
  if (!ref) return;
  cloudUnsubscribe = ref.onSnapshot((snap) => {
    if (!snap.exists || !snap.data().state) return;
    const data = snap.data();
    const pending = snap.metadata && snap.metadata.hasPendingWrites;
    if (pending) return;
    applyingRemoteState = true;
    try {
      state = data.state;
      state.agent = agent || state.agent || { uid: auth.currentUser?.uid, email: auth.currentUser?.email, name: auth.currentUser?.displayName || auth.currentUser?.email };
      migrateState();
      rollover();
      if ($('#login')) $('#login').classList.add('hidden');
      if ($('#dashboard')) $('#dashboard').classList.remove('hidden');
      render();
    } finally {
      applyingRemoteState = false;
    }
  }, (err) => {
    console.error('Erreur écoute Firebase', err);
    toast('Synchronisation Firebase interrompue. Vérifie la connexion.', 'warn');
  });
}
function cleanStateForCloud(){
  const data = JSON.parse(JSON.stringify(state || {}));
  if(data.agent){ delete data.agent.pin; }
  return data;
}
async function loadCloudState(agent){
  const ref = currentUserRef();
  if(!ref) return false;
  const snap = await ref.get();
  if(snap.exists && snap.data().state){
    state = snap.data().state;
    state.agent = agent;
    migrateState();
    return true;
  }
  state = {
    agent,
    today: dateKey(),
    tasks: [],
    sessions: [],
    selectedId: null,
    active: null,
    theme: localStorage.getItem('ttf_theme') || 'light',
    filter: 'all',
    historyMode: 'tasks',
    reminders: {},
    recoveryPool: [],
    history: [],
    mode: localStorage.getItem('ttf_mode') || 'full'
  };
  migrateState();
  await ref.set({email: agent.email, name: agent.name || '', state: cleanStateForCloud(), createdAt: firebase.firestore.FieldValue.serverTimestamp(), updatedAt: firebase.firestore.FieldValue.serverTimestamp()}, {merge:true});
  return false;
}
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const COLORS = [
  ['#ffe4e6', '#fb7185'], ['#fef3c7', '#f59e0b'], ['#dcfce7', '#22c55e'],
  ['#dbeafe', '#3b82f6'], ['#ede9fe', '#8b5cf6'], ['#fae8ff', '#d946ef'],
  ['#ccfbf1', '#14b8a6'], ['#ffedd5', '#f97316'], ['#e0f2fe', '#0ea5e9'],
  ['#fce7f3', '#ec4899'], ['#ecfccb', '#84cc16'], ['#fee2e2', '#ef4444']
];

let state = {
  agent: null,
  today: null,
  tasks: [],
  sessions: [],
  selectedId: null,
  active: null,
  theme: 'light',
  filter: 'all',
  historyMode: 'tasks',
  reminders: {},
  mode: localStorage.getItem('ttf_mode') || 'full',
  history: []
};
let manualTaskId = null;
let dragTaskId = null;

function dateKey(d = new Date()) { return d.toISOString().slice(0, 10); }
function pad(n) { return String(n).padStart(2, '0'); }
function hms(d = new Date()) { return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
function secToHMS(s) { s = Math.max(0, Math.round(s || 0)); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`; }
function parseHMS(t) { if (!t) return 0; const p = String(t).split(':').map(Number); return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0); }
function diffTimes(a, b) { let d = parseHMS(b) - parseHMS(a); if (d < 0) d += 86400; return d; }
function uid() { return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`; }
function esc(s = '') { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function keyFor(agent) { return `stg_${(agent?.uid || agent?.email || 'local').replace(/[^a-z0-9_-]/gi,'_')}`; }
function taskColor(i) { return COLORS[i % COLORS.length]; }

function taskDuration(id) {
  return (state.sessions || []).filter(s => s.taskId === id).reduce((a, s) => a + (Number(s.duration) || 0), 0);
}
function taskDisplayTime(t) {
  const active = state.active && state.active.taskId === t.id;
  if (active) return secToHMS(activeElapsed());
  return secToHMS(taskDuration(t.id));
}
function taskSortRank(t) {
  if (t.status === 'traitee') return 80;
  if (t.status === 'annulee' || t.status === 'deleguee') return 90;
  if (t.urgent) return 10;
  if (t.status === 'en_cours') return 15;
  if (t.status === 'pause' || t.status === 'reprendre') return 20;
  if (t.status === 'a_faire') return 30;
  if (t.status === 'reportee') return 60;
  return 70;
}
function reorganizeTasks() {
  state.tasks = (state.tasks || []).slice().sort((a, b) => taskSortRank(a) - taskSortRank(b) || (a.createdAt || 0) - (b.createdAt || 0));
  save(); renderQueue();
}

function normalizeTaskKey(t) {
  return `${(t.project || '').trim().toLowerCase()}::${(t.nature || '').trim().toLowerCase()}`;
}
function dedupeTaskList(list = []) {
  const seen = new Set();
  return (list || []).filter(t => {
    const key = normalizeTaskKey(t);
    if (!key || key === '::') return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function borderedExcelHtml(rows) {
  const css = 'border:1px solid #333;border-collapse:collapse;font-family:Arial,sans-serif;font-size:11pt;';
  const th = 'border:1px solid #333;background:#eaf2ff;font-weight:bold;padding:6px;text-align:left;';
  const td = 'border:1px solid #333;padding:6px;text-align:left;';
  return `<table style="${css}">${rows.map((r, i) => `<tr>${r.map(c => `<td style="${i === 0 ? th : td}">${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`;
}

function save() {
  if (!state.agent || applyingRemoteState) return;
  localStorage.setItem('stg_last_email', state.agent.email || '');
  lastLocalWriteAt = Date.now();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const ref = currentUserRef();
      if (!ref) return;
      await ref.set({
        email: state.agent.email,
        name: state.agent.name || '',
        state: cleanStateForCloud(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (e) {
      console.error('Erreur sauvegarde Firebase', e);
      toast('Sauvegarde Firebase impossible pour le moment. Vérifie la connexion.', 'warn');
    }
  }, 350);
}
async function load(agent) {
  await loadCloudState(agent);
}
function migrateState() {
  state.filter ||= 'all';
  state.historyMode ||= 'tasks';
  state.reminders ||= {};
  state.mode ||= localStorage.getItem('ttf_mode') || 'full';
  state.recoveryPool ||= [];
  state.history ||= [];
  state.theme ||= localStorage.getItem('ttf_theme') || 'light';
  state.tasks ||= [];
  state.sessions ||= [];
  state.tasks.forEach((t, i) => {
    t.createdAt ||= Date.now() - (state.tasks.length - i) * 1000;
    t.urgent = !!(t.urgent || t.priority === 'urgent');
    t.priority = t.urgent ? 'urgent' : 'normal';
    t.status ||= 'a_faire';
    t.qty = Number(t.qty) || 0;
    t.sessions ||= 0;
    if (!t.colorBg || !t.colorAccent) { const [bg, accent] = taskColor(i); t.colorBg = bg; t.colorAccent = accent; }
  });
  state.recoveryPool = dedupeTaskList((state.recoveryPool || []).map((t, i) => ({...t, recoveryId: t.recoveryId || uid(), urgent: !!(t.urgent || t.priority === 'urgent'), priority: (t.urgent || t.priority === 'urgent') ? 'urgent' : 'normal'})));
}

async function login() {
  resetLoginMsgStyle();
  const email = ($('#agentEmail')?.value || '').trim().toLowerCase();
  const name = ($('#agentName')?.value || '').trim();
  const pin = ($('#agentPin')?.value || '').trim();
  if (!email || !pin) { showLoginMsg('Complète ton email et ton PIN.'); return; }
  if (pin.length < 6) { showLoginMsg('Le PIN doit contenir au moins 6 caractères pour Firebase.'); return; }
  loginInProgress = true;
  $('#loginBtn').disabled = true;
  $('#loginBtn').textContent = 'Connexion...';
  try {
    let cred;
    try {
      cred = await auth.signInWithEmailAndPassword(email, pin);
    } catch (err) {
      if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential') {
        if (!name) {
          showLoginMsg('Première connexion détectée : ajoute ton nom pour créer ton espace.');
          return;
        }
        cred = await auth.createUserWithEmailAndPassword(email, pin);
        await cred.user.updateProfile({ displayName: name });
      } else if (err.code === 'auth/wrong-password') {
        showLoginMsg('PIN incorrect pour cet email.');
        return;
      } else {
        throw err;
      }
    }
    const user = cred.user;
    const agent = { uid: user.uid, email: user.email, name: name || user.displayName || email.split('@')[0] };
    await load(agent);
    if (name && state.agent.name !== name) state.agent.name = name;
    rollover();
    $('#login').classList.add('hidden');
    $('#dashboard').classList.remove('hidden');
    $('#loginMsg').classList.add('hidden');
    render();
    save();
    subscribeCloudState(agent);
    setTimeout(openRecoveryPrompt, 250);
  } catch (e) {
    console.error(e);
    const msg = {
      'auth/email-already-in-use': 'Cet email existe déjà. Utilise simplement ton PIN pour te connecter.',
      'auth/invalid-email': 'Adresse email invalide.',
      'auth/weak-password': 'PIN trop court : utilise au moins 6 caractères.',
      'auth/too-many-requests': 'Trop de tentatives. Réessaie plus tard.'
    }[e.code] || ('Connexion impossible : ' + (e.message || e.code || 'erreur inconnue'));
    showLoginMsg(msg);
  } finally {
    loginInProgress = false;
    $('#loginBtn').disabled = false;
    $('#loginBtn').textContent = 'Se connecter / créer mon espace';
  }
}
function showLoginMsg(t) { $('#loginMsg').textContent = t; $('#loginMsg').classList.remove('hidden'); }
function showLoginInfo(t) { const el = $('#loginMsg'); el.textContent = t; el.classList.remove('hidden'); el.classList.remove('error'); el.classList.add('hint'); }
function resetLoginMsgStyle(){ const el=$('#loginMsg'); if(!el)return; el.classList.add('error'); el.classList.remove('hint'); }
async function forgotPin(){
  resetLoginMsgStyle();
  const email = ($('#agentEmail')?.value || '').trim().toLowerCase();
  if(!email){ showLoginMsg('Indique d’abord ton email, puis clique sur PIN oublié.'); $('#agentEmail')?.focus(); return; }
  try{
    await auth.sendPasswordResetEmail(email);
    showLoginInfo('Email envoyé. Ouvre ta boîte mail pour créer un nouveau PIN, puis reviens te connecter.');
  }catch(e){
    console.error(e);
    const msg = {
      'auth/invalid-email':'Adresse email invalide.',
      'auth/user-not-found':'Aucun espace n’est associé à cet email.',
      'auth/too-many-requests':'Trop de demandes. Réessaie plus tard.'
    }[e.code] || ('Impossible d’envoyer l’email : ' + (e.message || e.code || 'erreur inconnue'));
    showLoginMsg(msg);
  }
}
function updateRememberedLogin(){
  const email = localStorage.getItem('stg_last_email') || '';
  const box = $('#rememberedLogin');
  if(!box) return;
  if(email){
    box.innerHTML = `Dernier espace utilisé : <b>${esc(email)}</b><br>Tu peux entrer seulement ton PIN si c’est toujours ton compte.<br><button class="btn ghost small" type="button" onclick="clearRememberedEmail()">Utiliser un autre email</button>`;
    box.classList.remove('hidden');
  }else{
    box.classList.add('hidden');
    box.innerHTML = '';
  }
}
function clearRememberedEmail(){
  localStorage.removeItem('stg_last_email');
  $('#agentEmail').value = '';
  $('#agentName').value = '';
  $('#agentPin').value = '';
  updateRememberedLogin();
  $('#agentEmail').focus();
}
async function logout() { save(); if (cloudUnsubscribe) { cloudUnsubscribe(); cloudUnsubscribe = null; } try { await auth.signOut(); } catch(e){} $('#dashboard').classList.add('hidden'); $('#login').classList.remove('hidden'); $('#agentPin').value = ''; updateRememberedLogin(); }
function switchAgent() { logout(); $('#agentEmail').value = ''; $('#agentName').value = ''; $('#agentPin').value = ''; }
function rollover() {
  const today = dateKey();
  if (!state.today) { state.today = today; return; }
  if (state.today !== today) {
    const old = { date: state.today, tasks: state.tasks, sessions: state.sessions };
    state.history ||= [];
    state.history.unshift(old);
    state.history = state.history.slice(0, 30);

    const seen = new Set();
    const carry = [];
    const recoveryPool = [];
    state.tasks.forEach((t, i) => {
      const blocked = ['annulee', 'deleguee'].includes(t.status);
      const unfinished = !['traitee', 'annulee', 'deleguee'].includes(t.status);
      const signature = `${(t.project || '').toLowerCase()}::${(t.nature || '').toLowerCase()}`;
      if (unfinished && !blocked && !seen.has(signature)) {
        seen.add(signature);
        carry.push({ ...t, id: uid(), status: 'a_faire', sessions: 0, createdAt: Date.now() + i, carriedFrom: state.today, reportAt: '' });
      } else {
        recoveryPool.push({ ...t, recoveryId: uid(), originalDate: state.today });
      }
    });
    state.today = today;
    state.tasks = carry;
    state.sessions = [];
    state.active = null;
    state.selectedId = carry[0]?.id || null;
    state.filter = 'all';
    state.recoveryPool = dedupeTaskList(recoveryPool);
  }
}

function setTheme(t) { state.theme = t; document.documentElement.dataset.theme = t; localStorage.setItem('ttf_theme', t); $('#themeBtn').textContent = t === 'dark' ? '☀️' : '🌙'; save(); }

function setMode(mode) {
  state.mode = mode === 'lite' ? 'lite' : 'full';
  localStorage.setItem('ttf_mode', state.mode);
  save();
  render();
}
function toggleMode() { setMode((state.mode || 'full') === 'full' ? 'lite' : 'full'); }
function isLite() { return (state.mode || 'full') === 'lite'; }

function addTask({ project = '', nature = '', qty = 1, details = '', urgent = false }) {
  const i = state.tasks.length;
  const [bg, accent] = taskColor(i);
  const t = { id: uid(), project, nature: nature || 'Nouvelle tâche', qty: Number(qty) || 1, details, urgent: !!urgent, priority: urgent ? 'urgent' : 'normal', status: 'a_faire', colorBg: bg, colorAccent: accent, sessions: 0, createdAt: Date.now(), reportAt: '' };
  state.tasks.push(t);
  if (!state.selectedId) state.selectedId = t.id;
  state.filter = 'all';
  save(); render();
}
function parseLine(line) {
  line = line.trim(); let qty = 1;
  const m = line.match(/(.+?)\s+x(\d+)$/i);
  if (m) { line = m[1].trim(); qty = Number(m[2]); }
  return { project: '', nature: line, qty, details: '', urgent: false };
}

function addBulk() {
  const lines = $('#bulkInput').value.split(/\n+/).map(x => x.trim()).filter(Boolean);
  lines.forEach(l => addTask(parseLine(l)));
  $('#bulkInput').value = '';
  if (lines.length) showMain();
}
function collapseToolsIfNeeded() { if (state.tasks.length) { $('#toolsBody')?.classList.add('hidden'); $('#toggleToolsBtn').textContent = '➕ Ajouter / coller'; } }
function showMain() { $('#toolsCol').classList.remove('hidden'); $('#emptyStart').classList.add('hidden'); $('#selectedCard').classList.remove('hidden'); }

function selectedTask() { return state.tasks.find(t => t.id === state.selectedId) || state.tasks[0]; }
function activeElapsed() {
  if (!state.active) return 0;
  let elapsed = state.active.elapsed || 0;
  if (state.active.running) elapsed += (Date.now() - state.active.lastStart) / 1000;
  return elapsed;
}
function getNextLogicText(currentId) {
  const tasks = state.tasks.filter(t => t.id !== currentId && !['traitee','annulee','deleguee'].includes(t.status));
  const next = tasks.find(t => t.urgent) || tasks.find(t => t.status === 'a_faire') || tasks[0];
  return next ? esc(next.nature) : '';
}
function render() {
  document.documentElement.dataset.theme = state.theme || 'light';
  const dash = $('#dashboard'); if (dash) dash.dataset.mode = state.mode || 'full';
  $('#themeBtn').textContent = state.theme === 'dark' ? '☀️' : '🌙';
  if ($('#modeBtn')) $('#modeBtn').textContent = isLite() ? 'Full Mode' : 'Lite Mode';
  $('#agentText').textContent = state.agent?.name || state.agent?.email || '';
  $('#todayText').textContent = new Date().toLocaleDateString('fr-FR');
  $('#clockText').textContent = hms();
  if (state.tasks.length) { showMain(); if (isLite()) $('#selectedCard').classList.add('hidden'); }
  else { $('#toolsCol').classList.add('hidden'); $('#emptyStart').classList.remove('hidden'); $('#selectedCard').classList.add('hidden'); }
  renderSelected(); renderQueue(); renderTable(); renderSmartStats(); syncFilterUI(); renderRecoveryPanel();
}
function renderSelected() {
  const t = selectedTask();
  if (!t) { $('#selectedContent').innerHTML = ''; return; }
  const card = $('#selectedCard');
  card.style.setProperty('--task-bg', t.colorBg);
  card.style.setProperty('--task-accent', t.colorAccent);
  card.classList.toggle('is-selected-urgent', !!t.urgent);
  card.classList.toggle('is-selected-done', t.status === 'traitee');
  const active = state.active && state.active.taskId === t.id;
  const paused = active && !state.active.running;
  const running = active && state.active.running;
  const done = t.status === 'traitee';
  let actionHtml = '';
  const nextHint = getNextLogicText(t.id);
  if (running) actionHtml = `<button class="btn pause" onclick="pauseTask()">⏸ Pause</button><button class="btn stop" onclick="stopTask()">■ STOP / Terminer</button><button class="btn ghost" onclick="stopAtPrecise()">Terminer à une heure précise</button>`;
  else if (paused) actionHtml = `<button class="btn continue" onclick="continueTask()">▶ Continuer</button><button class="btn stop" onclick="stopTask()">■ STOP / Terminer</button><button class="btn ghost" onclick="stopAtPrecise()">Terminer à une heure précise</button>`;
  else { const startLabel = done ? 'Reprendre / nouvelle session' : (['pause','reprendre'].includes(t.status) ? 'Continuer cette tâche' : 'Démarrer cette tâche'); actionHtml = `<button class="btn primary" onclick="startTask('${t.id}')">▶ ${startLabel}</button>${nextHint ? `<span class="next-inline">Tâche suivante : <b>${nextHint}</b></span>` : ''}`; }
  $('#selectedContent').innerHTML = `
    <button class="nav-side nav-left" onclick="selectPrev()" title="Tâche précédente">‹</button>
    <button class="nav-side nav-right" onclick="selectNext()" title="Tâche suivante">›</button>
    <div class="selected-top clean-selected-top">
      <div class="selected-title-wrap">
        <p class="micro">${running ? 'Tâche en cours' : paused ? 'Tâche en pause' : 'Tâche sélectionnée'}</p>
        <div class="inline-field project-line"><span class="selected-field-label">PROJET :</span><input class="project-input" id="selProject" value="${esc(t.project)}" placeholder="Nom du projet"><button class="pencil" onclick="focusSelect('selProject')">✎</button></div>
        <div class="inline-field task-line"><span class="selected-field-label">TÂCHE :</span><input class="task-title-input" id="selNature" value="${esc(t.nature)}" placeholder="Nom de la tâche"><button class="pencil" onclick="focusSelect('selNature')">✎</button></div>
      </div>
      <div class="selected-badges"><span class="status-pill status-${t.status}">${labelStatus(t.status)}</span><button class="urgent-pill ${t.urgent ? 'on' : ''}" onclick="toggleUrgent('${t.id}')">${t.urgent ? '🔥 Urgent' : '☆ Urgent'}</button></div>
    </div>
    <div class="timer ${paused ? 'paused' : ''}" id="timerText">${active ? secToHMS(activeElapsed()) : '00:00:00'}</div>
    <div class="form-grid"><div><label class="mini-label">Quantité</label><input class="input" id="selQty" type="number" min="0" value="${t.qty}"></div><div><label class="mini-label">Détails / Note</label><textarea id="selDetails" class="details-area" placeholder="Titre, URL, consigne, commentaire...">${esc(t.details)}</textarea></div></div>
    <div class="actions">${actionHtml}</div>`;
  ['selProject', 'selNature', 'selQty', 'selDetails'].forEach(id => {
    const el = $('#' + id);
    el.addEventListener('input', () => {
      const tt = selectedTask(); if (!tt) return;
      tt.project = $('#selProject').value;
      tt.nature = $('#selNature').value;
      tt.qty = Number($('#selQty').value) || 0;
      tt.details = $('#selDetails').value;
      save(); renderQueue();
    });
    el.addEventListener('keydown', fieldKeys);
  });
}

function updateTimerOnly() { const el = $('#timerText'); if (el && state.active) el.textContent = secToHMS(activeElapsed()); }
function fieldKeys(e) { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') e.stopPropagation(); }
function focusSelect(id) { const el = $('#' + id); el.focus(); setTimeout(() => el.select && el.select(), 0); }

function labelType(type) { return { temp: 'Temporaire', daily: 'Journalière', permanent: 'Permanente' }[type || 'temp'] || 'Temporaire'; }
function labelStatus(s) { return { a_faire: 'À faire', en_cours: 'En cours', pause: 'En pause', traitee: 'Traitée', reprendre: 'À reprendre', reportee: 'Reportée', deleguee: 'Déléguée', annulee: 'Annulée' }[s] || s; }
function badgeClass(s) { return s === 'traitee' ? 'done' : s === 'en_cours' ? 'running' : s === 'pause' ? 'pause' : 'todo'; }
function syncFilterUI() {
  $$('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === state.filter));
  const more = $('#moreFilter'); if (more) more.value = ['all','active', 'done', 'recent', 'urgent'].includes(state.filter) ? 'all' : state.filter;
}
function setFilter(f) { state.filter = f; save(); renderQueue(); syncFilterUI(); }
function getFilteredTasks() {
  let arr = state.tasks.map((t, index) => ({ ...t, _index: index }));
  switch (state.filter) {
    case 'done': arr = arr.filter(t => t.status === 'traitee'); break;
    case 'urgent': arr = arr.filter(t => (t.urgent || t.priority === 'urgent') && !['traitee', 'annulee', 'deleguee'].includes(t.status)); break;
    case 'recurring': arr = arr.filter(t => false); break;
    case 'recent': arr = arr.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); break;
    case 'pause': arr = arr.filter(t => t.status === 'pause'); break;
    case 'reprendre': arr = arr.filter(t => t.status === 'reprendre'); break;
    case 'reportee': arr = arr.filter(t => t.status === 'reportee'); break;
    case 'deleguee': arr = arr.filter(t => t.status === 'deleguee'); break;
    case 'annulee': arr = arr.filter(t => t.status === 'annulee'); break;
    case 'all': break;
    case 'active':
    default: arr = arr.filter(t => !['traitee', 'annulee', 'deleguee'].includes(t.status)); break;
  }
  return arr;
}

function liteActionControls(t) {
  const active = state.active && state.active.taskId === t.id;
  const running = active && state.active.running;
  const paused = (active && !state.active.running) || t.status === 'pause' || t.status === 'reprendre';
  const timer = taskDisplayTime(t);
  if (t.status === 'traitee') {
    return `<div class="lite-timebox done"><span class="lite-timer" data-task-id="${t.id}">${timer}</span><button class="btn ghost small mini-action" title="Nouvelle session" onclick="startTask('${t.id}')">↻</button></div>`;
  }
  if (running) {
    return `<div class="lite-timebox running"><span class="lite-timer" data-task-id="${t.id}">${timer}</span><button class="btn pause small mini-action" title="Pause" onclick="pauseTask()">⏸</button><button class="btn stop small mini-action" title="Stop / Terminer" onclick="stopTask()">■</button></div>`;
  }
  if (paused) {
    return `<div class="lite-timebox paused"><span class="lite-timer" data-task-id="${t.id}">${timer}</span><button class="btn continue small mini-action" title="Continuer" onclick="startTask('${t.id}')">▶</button><button class="btn stop small mini-action" title="Stop / Terminer" onclick="stopPausedTaskFromRow('${t.id}')">■</button></div>`;
  }
  return `<div class="lite-timebox"><span class="lite-timer" data-task-id="${t.id}">${timer}</span><button class="btn primary small mini-action" title="Démarrer" onclick="startTask('${t.id}')">▶</button></div>`;
}
function updateLiteTimers() {
  $$('.lite-timer').forEach(el => {
    const id = el.dataset.taskId;
    if (state.active && state.active.taskId === id) el.textContent = secToHMS(activeElapsed());
  });
}


function fullActionControls(t) {
  const active = state.active && state.active.taskId === t.id;
  const running = active && state.active.running;
  const paused = (active && !state.active.running) || t.status === 'pause' || t.status === 'reprendre';
  if (t.status === 'traitee') return `<button class="btn ghost small row-play" title="Nouvelle session" onclick="startTask('${t.id}')">↻</button>`;
  if (running) return `<span class="row-run-actions"><button class="btn pause small row-play" title="Pause" onclick="pauseTask()">⏸</button><button class="btn stop small row-play" title="Stop / Terminer" onclick="stopTask()">■</button></span>`;
  if (paused) return `<span class="row-run-actions"><button class="btn continue small row-play" title="Continuer" onclick="startTask('${t.id}')">▶</button><button class="btn stop small row-play" title="Stop / Terminer" onclick="stopPausedTaskFromRow('${t.id}')">■</button></span>`;
  return `<button class="btn primary small row-play" title="Démarrer" onclick="startTask('${t.id}')">▶</button>`;
}

function renderQueue() {
  const q = $('#queueList');
  const counts = {}; state.tasks.forEach(t => counts[t.status] = (counts[t.status] || 0) + 1);
  const urgentCount = state.tasks.filter(t => t.urgent && !['traitee','annulee','deleguee'].includes(t.status)).length;
  $('#statsText').textContent = `${state.tasks.length} tâche(s) · ${counts.traitee || 0} traitée(s) · ${counts.en_cours || 0} en cours · ${counts.pause || 0} en pause · ${urgentCount} urgent(s)`;
  if (!state.tasks.length) { q.innerHTML = '<div class="hint">Aucune tâche dans la liste.</div>'; return; }
  const list = getFilteredTasks();
  const visibleTotal = list.reduce((a, t) => a + taskDuration(t.id), 0);
  if (list.length) $('#statsText').textContent += ` · Total affiché : ${secToHMS(visibleTotal)}`;
  if (!list.length) { q.innerHTML = '<div class="hint">Aucune tâche pour ce filtre.</div>'; return; }
  q.innerHTML = list.map(t => `
    <div class="task-item task-item-v35 ${t.id === state.selectedId ? 'selected' : ''} ${t.status === 'traitee' ? 'is-done' : ''} ${t.urgent ? 'is-urgent' : ''}" draggable="true" data-id="${t.id}" style="--task-bg:${t.colorBg};--task-accent:${t.colorAccent}" onclick="selectTask('${t.id}')" ondragstart="dragStartTask(event,'${t.id}')" ondragover="dragOverTask(event)" ondrop="dropTask(event,'${t.id}')">
      <div class="drag-handle" title="Déplacer">⋮⋮</div>
      <div class="task-mainline"><div class="task-name" title="${esc(t.nature)}">${esc(t.nature)}</div><div class="task-mini">${t.project ? 'Projet : ' + esc(t.project) : 'Projet à compléter'}${t.details ? ' · ' + esc(t.details) : ''}${t.reportAt ? ' · Report : ' + formatReport(t.reportAt) : ''}</div></div>
      <div class="task-meta"><span class="badge ${badgeClass(t.status)}">${labelStatus(t.status)}</span>${(t.status === 'traitee' || taskDuration(t.id) > 0) ? `<span class="badge time-badge">⏱ ${taskDisplayTime(t)}</span>` : ''}${t.urgent ? '<span class="badge urgent-badge">🔥 Urgent</span>' : ''}${t.id === state.selectedId ? '<span class="badge">📌 Sélectionnée</span>' : ''}</div>
      <div class="task-controls clean-controls" onclick="event.stopPropagation()">
        ${isLite() ? liteActionControls(t) : fullActionControls(t)}
        <input class="input qty-inline" title="Quantité" type="number" min="0" value="${t.qty}" oninput="updateTask('${t.id}','qty',this.value)">
        <select class="input status-select" onchange="changeTaskStatus('${t.id}',this.value)">${['a_faire', 'pause', 'reportee', 'deleguee', 'annulee', 'traitee'].map(s => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${labelStatus(s)}</option>`).join('')}</select>
        <button class="btn ghost small icon-btn urgent-toggle" title="Urgent" onclick="toggleUrgent('${t.id}')">${t.urgent ? '🔥' : '☆'}</button>
        <button class="btn stop small icon-btn" title="Supprimer" onclick="deleteTask('${t.id}')">×</button>
      </div>
    </div>`).join('');
}

function changeTaskStatus(id, val) {
  const t = state.tasks.find(x => x.id === id); if (!t) return;
  if (val === 'traitee' && t.status !== 'traitee') {
    manualComplete(id);
    renderQueue();
    return;
  }
  if (val === 'reportee') {
    requestReport(id);
    return;
  }
  t.status = val;
  if (val !== 'reportee') t.reportAt = '';
  if (state.active?.taskId === id && !['en_cours', 'pause'].includes(val)) state.active = null;
  save(); render();
}
function requestReport(id) {
  const t = state.tasks.find(x => x.id === id); if (!t) return;
  const d = prompt('Reporter à quelle date ? (AAAA-MM-JJ)', dateKey());
  if (!d) { renderQueue(); return; }
  const tm = prompt('À quelle heure ? (HH:MM) — optionnel', '09:00') || '09:00';
  t.status = 'reportee';
  t.reportAt = `${d}T${tm.length === 5 ? tm : tm.slice(0,5)}`;
  save(); render();
  toast(`Tâche reportée au <b>${esc(formatReport(t.reportAt))}</b>. Elle deviendra urgente au moment prévu.`, 'info');
}
function formatReport(iso) {
  if (!iso) return '';
  const [d, t=''] = String(iso).split('T');
  const [y,m,day] = d.split('-');
  return `${day || ''}/${m || ''}/${y || ''}${t ? ' à ' + t.slice(0,5) : ''}`;
}
function updateTask(id, field, val) {
  const t = state.tasks.find(x => x.id === id); if (!t) return;
  if (field === 'qty') t.qty = Number(val) || 0; else t[field] = val;
  if (field === 'urgent') { t.urgent = !!val; t.priority = t.urgent ? 'urgent' : 'normal'; }
  save(); renderQueue(); renderSelected();
}
function selectTask(id) { state.selectedId = id; save(); render(); }
function selectNext() { if (!state.tasks.length) return; const list = getFilteredTasks(); const arr = list.length ? list : state.tasks; let i = arr.findIndex(t => t.id === state.selectedId); if (i < 0) i = 0; state.selectedId = arr[(i + 1) % arr.length].id; save(); render(); }
function selectPrev() { if (!state.tasks.length) return; const list = getFilteredTasks(); const arr = list.length ? list : state.tasks; let i = arr.findIndex(t => t.id === state.selectedId); if (i < 0) i = 0; state.selectedId = arr[(i - 1 + arr.length) % arr.length].id; save(); render(); }
function nextAvailable(afterId) { const i = state.tasks.findIndex(t => t.id === afterId); const arr = state.tasks.slice(i + 1).concat(state.tasks.slice(0, i + 1)); return arr.find(t => !['traitee', 'annulee', 'deleguee'].includes(t.status)) || state.tasks.find(t => t.id !== afterId) || state.tasks[0]; }
function moveTask(id, dir) { const i = state.tasks.findIndex(t => t.id === id); const j = i + dir; if (i < 0 || j < 0 || j >= state.tasks.length) return; [state.tasks[i], state.tasks[j]] = [state.tasks[j], state.tasks[i]]; save(); renderQueue(); }
function dragStartTask(e, id) { dragTaskId = id; e.dataTransfer.effectAllowed = 'move'; }
function dragOverTask(e) { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function dropTask(e, targetId) { e.preventDefault(); $$('.drag-over').forEach(x => x.classList.remove('drag-over')); if (!dragTaskId || dragTaskId === targetId) return; const from = state.tasks.findIndex(t => t.id === dragTaskId); const to = state.tasks.findIndex(t => t.id === targetId); if (from < 0 || to < 0) return; const [item] = state.tasks.splice(from, 1); state.tasks.splice(to, 0, item); dragTaskId = null; save(); renderQueue(); }
function toggleUrgent(id) { const t = state.tasks.find(x => x.id === id); if (!t) return; t.urgent = !t.urgent; t.priority = t.urgent ? 'urgent' : 'normal'; save(); render(); }

function startTask(id) {
  const t = state.tasks.find(x => x.id === id); if (!t) return;
  if (state.active && state.active.taskId === id && !state.active.running) { continueTask(); return; }
  if (state.active && state.active.taskId !== id) {
    if (state.active.running) pauseTask(true);
    finalizePausedSession();
  }
  const now = Date.now();
  state.active = { taskId: id, start: hms(), lastStart: now, elapsed: 0, running: true, pauseTime: null };
  t.status = 'en_cours'; state.selectedId = id; save(); render();
}
function pauseTask(silent = false) {
  if (!state.active) return;
  const t = state.tasks.find(x => x.id === state.active.taskId);
  state.active.elapsed = activeElapsed(); state.active.running = false; state.active.pauseTime = hms();
  if (t) t.status = 'pause';
  save(); if (!silent) render();
}
function continueTask() {
  if (!state.active) return;
  state.active.running = true; state.active.lastStart = Date.now(); state.active.pauseTime = null;
  const t = state.tasks.find(x => x.id === state.active.taskId); if (t) t.status = 'en_cours';
  save(); render();
}
function finalizePausedSession() {
  if (!state.active || state.active.running) return;
  const task = state.tasks.find(t => t.id === state.active.taskId); if (!task) return;
  const end = state.active.pauseTime || hms();
  const dur = Math.round(state.active.elapsed || 0);
  if (dur > 0) addSession(task, state.active.start, end, dur, task.qty, task.details);
  task.sessions = (task.sessions || 0) + 1;
  task.status = 'pause';
  state.active = null;
}

function stopPausedTaskFromRow(id) {
  if (state.active && state.active.taskId === id && !state.active.running) { stopTask(); return; }
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  if (task.status === 'pause' || task.status === 'reprendre') {
    state.selectedId = id;
    task.status = 'traitee';
    save();
    render();
  }
}
function stopTask() {
  if (!state.active) return;
  const task = state.tasks.find(t => t.id === state.active.taskId); if (!task) return;
  const end = state.active.running ? hms() : (state.active.pauseTime || hms());
  const dur = Math.round(activeElapsed());
  addSession(task, state.active.start, end, dur, task.qty, task.details);
  task.status = 'traitee'; task.sessions = (task.sessions || 0) + 1;
  const old = task.id; state.active = null;
  const n = nextAvailable(old); state.selectedId = n?.id || old;
  save(); render();
  remindAfterCompletion();
}
function stopAtPrecise() {
  if (!state.active) return;
  const v = prompt('Heure de fin précise (HH:MM:SS)', state.active.running ? hms() : (state.active.pauseTime || hms())); if (!v) return;
  const task = state.tasks.find(t => t.id === state.active.taskId); if (!task) return;
  const dur = Math.min(Math.round(activeElapsed()), diffTimes(state.active.start, v));
  addSession(task, state.active.start, v, dur, task.qty, task.details);
  task.status = 'traitee'; task.sessions = (task.sessions || 0) + 1;
  const old = task.id; state.active = null; const n = nextAvailable(old); state.selectedId = n?.id || old;
  save(); render();
  remindAfterCompletion();
}
function addSession(task, start, end, duration, qty, details) {
  state.sessions.push({ id: uid(), taskId: task.id, date: new Date().toLocaleDateString('fr-FR'), project: task.project, start, end, duration, nature: task.nature, qty: Number(qty) || 0, details: details || '', urgent: task.urgent || task.priority === 'urgent', priority: task.priority || 'normal', taskType: task.taskType || 'temp' });
}
function manualComplete(id) { manualTaskId = id; const now = hms(); $('#manualStart').value = now; $('#manualEnd').value = now; $('#manualOverlay').classList.remove('hidden'); renderManualTimes(); }
function validateManual() {
  const task = state.tasks.find(t => t.id === manualTaskId); if (!task) return;
  const mode = $('input[name="manualMode"]:checked').value;
  if (mode === 'none') task.status = 'traitee';
  else {
    let start = $('#manualStart').value || hms(), end = $('#manualEnd').value || hms(), details = task.details;
    if (mode === 'same' && state.active) { const activeTask = state.tasks.find(t => t.id === state.active.taskId); start = state.active.start; end = state.active.running ? hms() : (state.active.pauseTime || hms()); details = `${details ? details + ' · ' : ''}Fait en parallèle avec ${activeTask?.nature || 'la tâche active'}`; }
    addSession(task, start, end, diffTimes(start, end), task.qty, details); task.sessions = (task.sessions || 0) + 1; task.status = 'traitee';
  }
  $('#manualOverlay').classList.add('hidden');
  manualTaskId = null;
  save(); render();
  remindAfterCompletion();
}
function renderManualTimes() { const mode = $('input[name="manualMode"]:checked')?.value; $('#manualTimes').style.display = mode === 'manual' ? 'block' : 'none'; }
function deleteTask(id) { if (!confirm('Supprimer cette tâche ?')) return; state.tasks = state.tasks.filter(t => t.id !== id); if (state.selectedId === id) state.selectedId = state.tasks[0]?.id || null; if (state.active?.taskId === id) state.active = null; save(); render(); }

function renderTable() {
  const body = $('#sessionRows');
  body.innerHTML = state.sessions.map((s, i) => `<tr>
    <td>${s.date}</td>
    <td contenteditable onblur="editSession('${s.id}','project',this.textContent)">${esc(s.project)}</td>
    <td><div class="time-cell"><span contenteditable onblur="editSession('${s.id}','start',this.textContent)">${s.start}</span><span class="rounds"><button onclick="roundTime('${s.id}','start',1)">▲</button><button onclick="roundTime('${s.id}','start',-1)">▼</button></span></div></td>
    <td><div class="time-cell"><span contenteditable onblur="editSession('${s.id}','end',this.textContent)">${s.end}</span><span class="rounds"><button onclick="roundTime('${s.id}','end',1)">▲</button><button onclick="roundTime('${s.id}','end',-1)">▼</button></span></div></td>
    <td>${secToHMS(s.duration)}</td>
    <td contenteditable onblur="editSession('${s.id}','nature',this.textContent)">${esc(s.nature)}</td>
    <td contenteditable onblur="editSession('${s.id}','qty',this.textContent)">${s.qty}</td>
    <td contenteditable onblur="editSession('${s.id}','details',this.textContent)">${esc(s.details)}</td>
    <td class="row-actions"><button class="icon-btn" title="Monter" onclick="moveSession(${i},-1)">↑</button><button class="icon-btn" title="Descendre" onclick="moveSession(${i},1)">↓</button><button class="icon-btn danger" title="Supprimer" onclick="deleteSession('${s.id}')">×</button></td>
  </tr>`).join('');
  const total = state.sessions.reduce((a, s) => a + (Number(s.duration) || 0), 0);
  $('#totalHours').textContent = secToHMS(total);
}
function editSession(id, field, val) { const s = state.sessions.find(x => x.id === id); if (!s) return; s[field] = field === 'qty' ? Number(val) || 0 : val; if (field === 'start' || field === 'end') s.duration = diffTimes(s.start, s.end); save(); renderTable(); }
function roundTime(id, field, dir) { const s = state.sessions.find(x => x.id === id); if (!s) return; const step = 300; const sec = parseHMS(s[field]); const rounded = dir > 0 ? Math.ceil((sec + 1) / step) * step : Math.floor((sec - 1) / step) * step; s[field] = secToHMS((rounded + 86400) % 86400); s.duration = diffTimes(s.start, s.end); save(); renderTable(); }
function moveSession(i, dir) { const j = i + dir; if (j < 0 || j >= state.sessions.length) return; [state.sessions[i], state.sessions[j]] = [state.sessions[j], state.sessions[i]]; save(); renderTable(); }
function deleteSession(id) { state.sessions = state.sessions.filter(s => s.id !== id); save(); renderTable(); }
function copyTable() { const rows = [['Date', 'Projet', 'Heure début', 'Heure fin', 'Total heure', 'Nature', 'Quantité', 'Détails / Note'], ...state.sessions.map(s => [s.date, s.project, s.start, s.end, secToHMS(s.duration), s.nature, s.qty, s.details]), ['', '', '', '', $('#totalHours').textContent, '', '', '']]; navigator.clipboard?.writeText(rows.map(r => r.join('\t')).join('\n')); }
function exportTable() { const rows = [['Date', 'Projet', 'Heure début', 'Heure fin', 'Total heure', 'Nature', 'Quantité', 'Détails / Note'], ...state.sessions.map(s => [s.date, s.project, s.start, s.end, secToHMS(s.duration), s.nature, s.qty, s.details]), ['', '', '', '', $('#totalHours').textContent, '', '', '']]; const html = borderedExcelHtml(rows); const blob = new Blob(['\ufeff' + html], { type: 'application/vnd.ms-excel' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `saisie-temps-${(state.agent.name || state.agent.email || 'agent').replace(/[^a-z0-9_-]/gi,'_')}-${state.today}.xls`; a.click(); }

function historyKey() { return `${keyFor(state.agent)}_history`; }
function getHistoryDays(includeToday = true) {
  const hist = state.history || [];
  const days = includeToday ? [{ date: state.today || dateKey(), tasks: state.tasks || [], sessions: state.sessions || [], current: true }, ...hist] : hist;
  return days.slice(0, 30);
}
function openHistory() {
  state.historyMode ||= 'tasks';
  renderHistory();
  $('#historyOverlay').classList.remove('hidden');
}
function renderHistory() {
  const days = getHistoryDays(true);
  $('#historyTasksTab').classList.toggle('active', state.historyMode === 'tasks');
  $('#historyTablesTab').classList.toggle('active', state.historyMode === 'tables');
  if (!days.length) { $('#historyContent').innerHTML = '<div class="hint">Aucun historique pour le moment.</div>'; return; }
  $('#historyContent').innerHTML = days.map((d, di) => {
    const done = (d.tasks || []).filter(t => t.status === 'traitee').length;
    const pending = (d.tasks || []).filter(t => !['traitee','annulee','deleguee'].includes(t.status)).length;
    const urgent = (d.tasks || []).filter(t => (t.urgent || t.priority === 'urgent') && !['traitee','annulee','deleguee'].includes(t.status)).length;
    const total = (d.sessions || []).reduce((a, s) => a + (Number(s.duration) || 0), 0);
    const label = `${formatDateFr(d.date)}${d.current ? ' · aujourd’hui' : ''}`;
    const body = state.historyMode === 'tables' ? renderHistoryTableBlock(d, di) : renderHistoryTasksBlock(d, di);
    return `<div class="history-day"><div class="history-date-row"><button class="history-date" onclick="toggleHistoryDay(${di})"><strong>${label}</strong><span>${(d.sessions || []).length} ligne(s) · ${secToHMS(total)} · ${done} traitée(s) · ${pending} à suivre · ${urgent} urgent(s)</span></button><button class="icon-btn danger" title="Supprimer cette date" onclick="deleteHistoryDay(${di})">×</button></div><div id="histBody${di}" class="history-body ${di === 0 ? '' : 'hidden'}">${body}</div></div>`;
  }).join('');
}
function renderHistoryTasksBlock(d, di) {
  const tasks = dedupeTaskList(d.tasks || []);
  if (!tasks.length) return '<div class="hint">Aucune tâche enregistrée pour cette date.</div>';
  return `<div class="history-section-title">Tâches de la journée</div>${tasks.map(t => `<div class="history-task"><span><b>${esc(t.project ? t.project + ' · ' : '')}${esc(t.nature)}</b><small>${labelStatus(t.status)}${t.urgent ? ' · Urgent' : ''}${t.reportAt ? ' · Reporté au ' + formatReport(t.reportAt) : ''}${t.details ? ' · ' + esc(t.details) : ''}</small></span><div class="history-task-actions"><button class="btn ghost small" onclick="recoverTask(${di},'${t.id}')">Récupérer</button><button class="icon-btn danger" title="Supprimer cette tâche" onclick="deleteHistoryTask(${di},'${t.id}')">×</button></div></div>`).join('')}`;
}
function renderHistoryTableBlock(d, di) {
  const sessions = d.sessions || [];
  if (!sessions.length) return '<div class="hint">Aucune ligne Saisie temps enregistrée pour cette date.</div>';
  const total = sessions.reduce((a, s) => a + (Number(s.duration) || 0), 0);
  return `<div class="history-actions"><button class="btn ghost small" onclick="copyHistoryTable(${di})">Copier ce tableau</button><button class="btn primary small" onclick="exportHistoryTable(${di})">Exporter ce tableau</button></div><div class="table-wrap history-table"><table><thead><tr><th>Date</th><th>Projet</th><th>Début</th><th>Fin</th><th>Total</th><th>Nature</th><th>Quantité</th><th>Détails</th></tr></thead><tbody>${sessions.map(s => `<tr><td>${esc(s.date || formatDateFr(d.date))}</td><td>${esc(s.project)}</td><td>${esc(s.start)}</td><td>${esc(s.end)}</td><td>${secToHMS(s.duration)}</td><td>${esc(s.nature)}</td><td>${esc(s.qty)}</td><td>${esc((s.urgent ? '[Urgent] ' : '') + (s.details || ''))}</td></tr>`).join('')}</tbody><tfoot><tr class="total-row"><td colspan="4">Total</td><td>${secToHMS(total)}</td><td colspan="3"></td></tr></tfoot></table></div>`;
}
function toggleHistoryDay(di) { const el = $('#histBody' + di); if (el) el.classList.toggle('hidden'); }
function setHistoryMode(mode) { state.historyMode = mode; save(); renderHistory(); }
function closeHistory() { $('#historyOverlay').classList.add('hidden'); }
function recoverTask(di, id) { const d = getHistoryDays(true)[di]; const t = d?.tasks?.find(x => x.id === id); if (!t) return; addTask({ project: t.project, nature: t.nature, qty: t.qty, details: t.details, urgent: t.urgent }); }

function saveHistoryDays(days) {
  state.history = days.filter(d => !d.current).slice(0, 30);
  save();
}
function deleteHistoryDay(di) {
  const days = getHistoryDays(true);
  const d = days[di]; if (!d) return;
  if (!confirm(`Supprimer tout l'historique du ${formatDateFr(d.date)} ?`)) return;
  if (d.current) {
    state.tasks = []; state.sessions = []; state.active = null; state.selectedId = null; save(); render();
  } else {
    days.splice(di, 1); saveHistoryDays(days); renderHistory();
  }
}
function deleteHistoryTask(di, id) {
  const days = getHistoryDays(true); const d = days[di]; if (!d) return;
  if (!confirm('Supprimer cette tâche dans l’historique ?')) return;
  if (d.current) {
    state.tasks = state.tasks.filter(t => t.id !== id);
    if (state.selectedId === id) state.selectedId = state.tasks[0]?.id || null;
    save(); render(); renderHistory();
  } else {
    d.tasks = (d.tasks || []).filter(t => t.id !== id);
    saveHistoryDays(days); renderHistory();
  }
}
function historyRows(di) { const d = getHistoryDays(true)[di]; const sessions = d?.sessions || []; const total = sessions.reduce((a, s) => a + (Number(s.duration) || 0), 0); return { d, rows: [['Date','Projet','Heure début','Heure fin','Total heure','Nature','Quantité','Détails / Note'], ...sessions.map(s => [s.date || formatDateFr(d.date), s.project, s.start, s.end, secToHMS(s.duration), s.nature, s.qty, s.details]), ['', '', '', 'Total', secToHMS(total), '', '', '']] }; }
function copyHistoryTable(di) { const { rows } = historyRows(di); navigator.clipboard?.writeText(rows.map(r => r.join('\t')).join('\n')); toast('Tableau Saisie temps copié.'); }
function exportHistoryTable(di) { const { d, rows } = historyRows(di); const html = borderedExcelHtml(rows); const blob = new Blob(['\ufeff' + html], { type: 'application/vnd.ms-excel' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `saisie-temps-${(state.agent.name || state.agent.email || 'agent').replace(/[^a-z0-9_-]/gi,'_')}-${d.date}.xls`; a.click(); }
function formatDateFr(key) { const [y,m,d] = String(key || '').split('-'); return y && m && d ? `${d}/${m}/${y}` : key; }

function renderSmartStats() {
  const box = $('#smartStats'); if (!box) return;
  const pending = state.tasks.filter(t => !['traitee','annulee','deleguee'].includes(t.status));
  const urgent = pending.filter(t => t.urgent);
  const done = state.tasks.filter(t => t.status === 'traitee');
  const reported = state.tasks.filter(t => t.status === 'reportee');
  const total = state.sessions.reduce((a,s)=>a+(Number(s.duration)||0),0);
  box.innerHTML = `<div class="stat-card urgent-stat"><span>${urgent.length}</span><b>Urgent(s)</b></div><div class="stat-card"><span>${pending.length}</span><b>À faire</b></div><div class="stat-card"><span>${done.length}</span><b>Traité(s)</b></div><div class="stat-card"><span>${reported.length}</span><b>Reportée(s)</b></div><div class="stat-card"><span>${secToHMS(total)}</span><b>Total Heures</b></div>`;
}
function pendingUrgents() { return state.tasks.filter(t => t.urgent && !['traitee','annulee','deleguee'].includes(t.status)); }
function toast(msg, type='info') { const el = $('#toast'); if (!el) return; el.innerHTML = msg + '<button class="toast-close" onclick="hideToast(event)">×</button>'; el.className = `toast ${type}`; clearTimeout(window.__toastTimer); window.__toastTimer = setTimeout(()=>el.classList.add('hidden'), 12000); }
function hideToast(e) { if (e) e.stopPropagation(); const el = $('#toast'); if (el) el.classList.add('hidden'); }
function remindUrgents(reason = 'hourly') {
  const urg = pendingUrgents(); if (!urg.length) return;
  const list = urg.slice(0,3).map(t => `• ${esc(t.nature)}`).join('<br>');
  toast(`Attention : ${urg.length} tâche(s) urgente(s) encore à traiter.<br>${list}`, 'warn');
  state.reminders.lastUrgentAt = Date.now(); save();
}
function remindAfterCompletion() {
  renderSmartStats();
  if (pendingUrgents().length) remindUrgents('completion');
  else {
    const next = state.tasks.find(t => !['traitee','annulee','deleguee'].includes(t.status));
    if (next) toast(`Plus d’urgence. Prochaine tâche logique : <b>${esc(next.nature)}</b>.`, 'info');
  }
}

function checkReportsDue() {
  let changed = false;
  const now = Date.now();
  state.tasks.forEach(t => {
    if (t.status === 'reportee' && t.reportAt) {
      const due = new Date(t.reportAt).getTime();
      if (!Number.isNaN(due) && due <= now) {
        t.status = 'a_faire';
        t.urgent = true;
        t.priority = 'urgent';
        t.reportAt = '';
        changed = true;
      }
    }
  });
  if (changed) { save(); render(); toast('Une ou plusieurs tâches reportées sont arrivées à échéance : elles passent en <b>Urgent</b>.', 'warn'); }
}

function checkReminders() {
  if (!state.agent) return;
  const now = Date.now(); state.reminders ||= {};
  checkReportsDue();
  if (pendingUrgents().length && (!state.reminders.lastUrgentAt || now - state.reminders.lastUrgentAt > 3600000)) remindUrgents('hourly');
  if (state.active && state.active.running && activeElapsed() > 3600) {
    const key = `${state.active.taskId}_${Math.floor(activeElapsed()/900)}`;
    if (state.reminders.longTaskKey !== key) {
      const t = state.tasks.find(x=>x.id===state.active.taskId);
      toast(`Cette tâche dépasse 1h : <b>${esc(t?.nature || 'tâche en cours')}</b>. Pense à vérifier les urgences ou à découper la tâche.`, 'warn');
      state.reminders.longTaskKey = key; save();
    }
  }
}


function openRecoveryPrompt() {
  if (!state.agent || !(state.recoveryPool || []).length) return;
  renderRecoveryPrompt();
  $('#recoveryOverlay')?.classList.remove('hidden');
}
function renderRecoveryPrompt() {
  const box = $('#recoveryList'); if (!box) return;
  const items = state.recoveryPool || [];
  box.innerHTML = items.length ? items.map(t => `<div class="recovery-item"><div><b>${esc(t.nature)}</b><small>${esc(t.project || 'Projet non renseigné')} · ${labelStatus(t.status)}${t.urgent ? ' · Urgent' : ''}</small></div><div class="recovery-actions"><button class="btn primary small" onclick="recoverSuggestedTask('${t.recoveryId}')">Ajouter</button><button class="icon-btn danger" title="Supprimer" onclick="deleteRecoveryItem('${t.recoveryId}')">×</button></div></div>`).join('') : '<div class="hint">Aucune tâche à proposer.</div>';
}
function recoverSuggestedTask(recoveryId) {
  const pool = state.recoveryPool || [];
  const t = pool.find(x => x.recoveryId === recoveryId); if (!t) return;
  addTask({ project: t.project, nature: t.nature, qty: t.qty, details: t.details, urgent: t.urgent });
  state.recoveryPool = pool.filter(x => x.recoveryId !== recoveryId);
  save(); renderRecoveryPrompt(); renderRecoveryPanel();
}
function deleteRecoveryItem(recoveryId) {
  state.recoveryPool = (state.recoveryPool || []).filter(x => x.recoveryId !== recoveryId);
  save(); renderRecoveryPrompt(); renderRecoveryPanel();
}
function closeRecoveryPrompt() { $('#recoveryOverlay')?.classList.add('hidden'); save(); renderRecoveryPanel(); }
function buildSuggestedTasks() {
  const raw = [];
  (state.recoveryPool || []).forEach(t => raw.push({ ...t, source: 'recovery' }));
  (state.tasks || []).forEach(t => raw.push({ ...t, source: 'today' }));
  try {
    const hist = state.history || [];
    hist.forEach(day => (day.tasks || []).forEach(t => raw.push({ ...t, source: day.date || 'history' })));
  } catch (e) {}
  const seen = new Set();
  return raw.filter(t => {
    const key = normalizeTaskKey(t);
    if (!key || key === '::') return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 60);
}
function fillAddFieldsFromTask(t) {
  if (!t) return;
  $('#singleBox').classList.remove('hidden');
  $('#bulkBox').classList.add('hidden');
  $('#addProject').value = t.project || '';
  $('#addNature').value = t.nature || '';
  $('#addQty').value = Number(t.qty) || 1;
  $('#addDetails').value = t.details || '';
  $('#addUrgent').checked = !!(t.urgent || t.priority === 'urgent');
  $('#toolsBody').classList.remove('hidden');
  $('#toggleToolsBtn').textContent = 'Réduire';
  $('#addQty').focus();
  toast('1 clic : les informations sont dans les champs. Modifie si besoin, puis clique sur <b>Ajouter cette tâche</b>.', 'info');
}

let suggestedClickTimer = null;
function handleSuggestedClick(index, event) {
  if (event && event.detail >= 2) {
    if (suggestedClickTimer) { clearTimeout(suggestedClickTimer); suggestedClickTimer = null; }
    addSuggestedTask(index);
    return;
  }
  if (suggestedClickTimer) clearTimeout(suggestedClickTimer);
  suggestedClickTimer = setTimeout(() => {
    fillSuggestedTask(index);
    suggestedClickTimer = null;
  }, 190);
}

function fillSuggestedTask(index) {
  const t = (window.__suggestedTasks || [])[Number(index)];
  fillAddFieldsFromTask(t);
}
function addSuggestedTask(index) {
  const t = (window.__suggestedTasks || [])[Number(index)];
  if (!t) return;
  addTask({ project: t.project, nature: t.nature, qty: t.qty, details: t.details, urgent: !!(t.urgent || t.priority === 'urgent') });
  if (t.source === 'recovery' && t.recoveryId) {
    state.recoveryPool = (state.recoveryPool || []).filter(x => x.recoveryId !== t.recoveryId);
    save();
  }
  renderRecoveryPanel();
}
function renderRecoveryPanel() {
  const box = $('#recoveryBox'); if (!box) return;
  const items = buildSuggestedTasks();
  window.__suggestedTasks = items;
  if (!items.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = `<p class="micro">Tâches rapides</p><h3>Historique / tâches existantes</h3><p class="suggestion-help"><b>1 clic</b> = mettre les infos dans les champs pour les modifier · <b>2 clics</b> = ajouter directement dans la liste à faire</p><div class="suggestion-grid">${items.map((t,i) => `<button class="suggestion-chip ${t.urgent ? 'urgent' : ''}" onclick="handleSuggestedClick(${i}, event)" title="${esc(t.project || '')} ${esc(t.nature || '')}"><b>${esc(t.nature)}</b><small>${esc(t.project || 'Sans projet')}${t.urgent ? ' · Urgent' : ''}</small></button>`).join('')}</div>`;
}


function resetWorkspace() {
  if (!state.agent) return;
  const agentLabel = state.agent.name || state.agent.email || 'cet agent';
  const msg1 = `Réinitialiser l’espace ${agentLabel} ?\n\nToutes les tâches, les historiques, les tableaux Saisie temps, les tâches à récupérer et les données de test seront supprimés définitivement dans Firebase pour ce compte.`;
  if (!confirm(msg1)) return;
  const typed = prompt('Pour confirmer, écris exactement : TOUT VIDER');
  if (typed !== 'TOUT VIDER') {
    alert('Réinitialisation annulée.');
    return;
  }
  const agent = state.agent;
  const theme = state.theme || localStorage.getItem('ttf_theme') || 'light';
  const mode = state.mode || localStorage.getItem('ttf_mode') || 'full';
  state = { agent, today: dateKey(), tasks: [], sessions: [], selectedId: null, active: null, theme, filter: 'all', historyMode: 'tasks', reminders: {}, recoveryPool: [], history: [], mode };
  save();
  render();
  alert('Espace réinitialisé. Tu repars sur une base vide.');
}


function openHelp(){ document.querySelector('#helpOverlay')?.classList.remove('hidden'); }
function closeHelp(){ document.querySelector('#helpOverlay')?.classList.add('hidden'); }

function openChangePin(){
  $('#pinMsg')?.classList.add('hidden');
  $('#oldPin').value = '';
  $('#newPin').value = '';
  $('#confirmPin').value = '';
  $('#changePinOverlay')?.classList.remove('hidden');
}
function closeChangePin(){ $('#changePinOverlay')?.classList.add('hidden'); }
function showPinMsg(t){ const el=$('#pinMsg'); if(!el)return; el.textContent=t; el.classList.remove('hidden'); }
async function validatePinChange(){
  const oldPin = $('#oldPin').value.trim();
  const newPin = $('#newPin').value.trim();
  const confirmPin = $('#confirmPin').value.trim();
  const user = auth.currentUser;
  if(!user || !user.email){ showPinMsg('Session Firebase introuvable. Reconnecte-toi.'); return; }
  if(!oldPin || !newPin || !confirmPin){ showPinMsg('Complète les 3 champs.'); return; }
  if(newPin.length < 6){ showPinMsg('Le nouveau PIN doit contenir au moins 6 caractères.'); return; }
  if(newPin !== confirmPin){ showPinMsg('Le nouveau PIN et la confirmation ne correspondent pas.'); return; }
  try{
    const credential = firebase.auth.EmailAuthProvider.credential(user.email, oldPin);
    await user.reauthenticateWithCredential(credential);
    await user.updatePassword(newPin);
    closeChangePin();
    toast('PIN modifié avec succès.', 'info');
  }catch(e){
    console.error(e);
    showPinMsg(e.code === 'auth/wrong-password' || e.code === 'auth/invalid-credential' ? 'PIN actuel incorrect.' : 'Modification impossible : ' + (e.message || e.code));
  }
}

async function restoreFirebaseSession(user){
  if (!user) return;
  const agent = { uid: user.uid, email: user.email, name: user.displayName || (user.email || '').split('@')[0] };
  try {
    await load(agent);
    rollover();
    $('#login').classList.add('hidden');
    $('#dashboard').classList.remove('hidden');
    render();
    subscribeCloudState(agent);
    setTimeout(openRecoveryPrompt, 250);
  } catch(e) {
    console.error('Restauration session impossible', e);
    showLoginMsg('Session trouvée, mais chargement impossible. Reconnecte-toi.');
  }
}

function bind() {
  $('#loginBtn').onclick = login; const fp=$('#forgotPinBtn'); if(fp) fp.onclick = forgotPin; ['#agentEmail','#agentName','#agentPin'].forEach(sel => { const el = $(sel); if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); login(); } }); }); $('#switchBtn').onclick = switchAgent; $('#quitBtn').onclick = logout; $('#themeBtn').onclick = () => setTheme((state.theme || 'light') === 'dark' ? 'light' : 'dark'); if ($('#modeBtn')) $('#modeBtn').onclick = toggleMode; const oh=$('#openHelpBtn'); if(oh) oh.onclick=openHelp; const fh=$('#footerHelpBtn'); if(fh) fh.onclick=openHelp; const ch=$('#closeHelp'); if(ch) ch.onclick=closeHelp; const ho=$('#helpOverlay'); if(ho) ho.onclick=e=>{ if(e.target.id==='helpOverlay') closeHelp(); }; const rsb = $('#resetSpaceBtn'); if (rsb) rsb.onclick = resetWorkspace; if ($('#changePinBtn')) $('#changePinBtn').onclick = openChangePin; if ($('#closeChangePin')) $('#closeChangePin').onclick = closeChangePin; if ($('#validatePinChange')) $('#validatePinChange').onclick = validatePinChange; if ($('#changePinOverlay')) $('#changePinOverlay').onclick = e => { if (e.target.id === 'changePinOverlay') closeChangePin(); };
  $('#openTableBtn').onclick = () => { $('#tableOverlay').classList.remove('hidden'); renderTable(); }; $('#closeTable').onclick = () => $('#tableOverlay').classList.add('hidden'); $('#tableOverlay').onclick = e => { if (e.target.id === 'tableOverlay') $('#tableOverlay').classList.add('hidden'); };
  $('#openHistoryBtn').onclick = openHistory; $('#closeHistory').onclick = closeHistory; $('#historyTasksTab').onclick = () => setHistoryMode('tasks'); $('#historyTablesTab').onclick = () => setHistoryMode('tables'); $('#historyOverlay').onclick = e => { if (e.target.id === 'historyOverlay') closeHistory(); };
  $('#emptySingle').onclick = () => { showMain(); $('#toolsCol').classList.remove('hidden'); $('#toolsBody').classList.remove('hidden'); $('#singleBox').classList.remove('hidden'); $('#bulkBox').classList.add('hidden'); $('#addNature').focus(); };
  $('#emptyBulk').onclick = () => { showMain(); $('#toolsCol').classList.remove('hidden'); $('#toolsBody').classList.remove('hidden'); $('#bulkBox').classList.remove('hidden'); $('#singleBox').classList.add('hidden'); $('#bulkInput').focus(); };
  $('#showSingleBtn').onclick = () => { $('#singleBox').classList.remove('hidden'); $('#bulkBox').classList.add('hidden'); };
  $('#showBulkBtn').onclick = () => { $('#bulkBox').classList.remove('hidden'); $('#singleBox').classList.add('hidden'); $('#bulkInput').focus(); };
  $('#toggleToolsBtn').onclick = () => { const b = $('#toolsBody'); b.classList.toggle('hidden'); $('#toggleToolsBtn').textContent = b.classList.contains('hidden') ? '➕ Ajouter / coller' : 'Réduire'; };
  $('#addTaskBtn').onclick = () => { addTask({ project: $('#addProject').value, nature: $('#addNature').value, qty: $('#addQty').value, details: $('#addDetails').value, urgent: $('#addUrgent').checked }); ['addProject', 'addNature', 'addDetails'].forEach(id => $('#' + id).value = ''); $('#addQty').value = 1; $('#addUrgent').checked = false; };
  $('#bulkBtn').onclick = addBulk; $('#copyBtn').onclick = copyTable; $('#exportBtn').onclick = exportTable; $('#closeManual').onclick = () => $('#manualOverlay').classList.add('hidden'); $('#validateManual').onclick = validateManual; $$('input[name="manualMode"]').forEach(r => r.onchange = renderManualTimes);
  $$('.filter-btn').forEach(b => b.onclick = () => setFilter(b.dataset.filter)); $('#moreFilter').onchange = (e) => setFilter(e.target.value); const rb = $('#reorderBtn'); if (rb) rb.onclick = reorganizeTasks;
  document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) e.stopPropagation(); });
  document.addEventListener('click', e => { const toastEl = $('#toast'); if (toastEl && !toastEl.classList.contains('hidden') && !toastEl.contains(e.target)) toastEl.classList.add('hidden'); });
}
setInterval(() => { if ($('#clockText')) $('#clockText').textContent = hms(); if (state.active && state.agent) { updateTimerOnly(); updateLiteTimers(); } }, 1000);
setInterval(checkReminders, 60000);
bind();
auth.onAuthStateChanged(user => { if (user && !state.agent && !loginInProgress) restoreFirebaseSession(user); });
try { const lastEmail = localStorage.getItem('stg_last_email') || ''; if (lastEmail && $('#agentEmail')) $('#agentEmail').value = lastEmail; updateRememberedLogin(); } catch (e) {}
