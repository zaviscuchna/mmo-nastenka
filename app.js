// MMO nástěnka — vizuální přední strana pro issues v zaviscuchna/mmo-rpg.
// Nápad / návrh = issue, hlas = reakce 👍/👎, obrázky = soubory v repu.
// Všechno, co se tu udělá, je vidět i přímo na GitHubu.

const CFG = {
  owner: 'zaviscuchna',
  repo: 'mmo-rpg',
  branch: 'main',
  team: [
    { login: 'zaviscuchna', name: 'Záviš' },
    { login: 'rozporkavojta-png', name: 'Vojta' },
    { login: 'filsocht', name: 'Tomáš' },
  ],
};

const TYPES = { napad: 'nápad', grafika: 'grafika' };
const HIDDEN_LABEL = 'smazáno';
const STATE_LABELS = { diskuse: 'diskuse', schvaleno: 'schváleno', zamitnuto: 'zamítnuto' };
const STATE_NAMES = { novy: 'Nové', diskuse: 'Diskuse', schvaleno: 'Schváleno', zamitnuto: 'Zamítnuto' };
const CATS = {
  napad: ['svět', 'boj', 'postavy', 'ekonomika', 'art', 'tech'],
  grafika: ['postava', 'prostředí', 'předmět', 'ui', 'moodboard'],
};
const ART_DIR = { postava: 'postavy', 'prostředí': 'prostredi', 'předmět': 'predmety', ui: 'ui', moodboard: 'moodboard' };
const META_RE = /<!--\s*nastenka\s+(\{[\s\S]*?\})\s*-->/;
const TOKEN_KEY = 'mmo-nastenka-token';

const $ = (s) => document.querySelector(s);
const state = {
  token: null,
  me: null,
  admin: false, // jen správce repa smí issue opravdu smazat, ostatní ho jen skryjí
  items: [],
  tab: 'vse',
  states: new Set(['novy', 'diskuse']),
  cat: '',
};

// ---------- drobnosti ----------

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}

function store(key, val) {
  try { val == null ? localStorage.removeItem(key) : localStorage.setItem(key, val); } catch {}
}
function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), bad ? 6000 : 2500);
}

const nameOf = (login) => CFG.team.find((m) => m.login === login)?.name || login;

function slug(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'navrh';
}

function fileToBase64(file) {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1]);
    r.onerror = fail;
    r.readAsDataURL(file);
  });
}
function blobToBase64(blob) { return fileToBase64(blob); }

function relTime(iso) {
  const d = (Date.now() - new Date(iso)) / 1000;
  if (d < 60) return 'teď';
  if (d < 3600) return `před ${Math.floor(d / 60)} min`;
  if (d < 86400) return `před ${Math.floor(d / 3600)} h`;
  if (d < 86400 * 7) return `před ${Math.floor(d / 86400)} d`;
  return new Date(iso).toLocaleDateString('cs-CZ');
}

// ---------- GitHub API ----------

const REPO = `/repos/${CFG.owner}/${CFG.repo}`;

async function gh(path, { method = 'GET', body, accept, raw = false } = {}) {
  const res = await fetch(path.startsWith('http') ? path : 'https://api.github.com' + path, {
    method,
    cache: 'no-store', // GitHub posílá max-age=60 a čerstvé hlasy/komentáře by se neukázaly
    headers: {
      Authorization: `Bearer ${state.token}`,
      Accept: accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).message || msg; } catch {}
    const err = new Error(`GitHub ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  if (raw) return res;
  if (res.status === 204) return null;
  return res.json();
}

async function ghAll(path) {
  const out = [];
  for (let page = 1; page < 20; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const batch = await gh(`${path}${sep}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

const imgCache = new Map();
function repoImage(path) {
  if (!imgCache.has(path)) {
    imgCache.set(path, gh(`${REPO}/contents/${encPath(path)}?ref=${CFG.branch}`, {
      accept: 'application/vnd.github.raw', raw: true,
    }).then((r) => r.blob()).catch((e) => { imgCache.delete(path); throw e; }));
  }
  return imgCache.get(path);
}

async function putFile(path, base64, message) {
  let sha;
  try {
    sha = (await gh(`${REPO}/contents/${encPath(path)}?ref=${CFG.branch}`)).sha;
  } catch (e) { if (e.status !== 404) throw e; }
  return gh(`${REPO}/contents/${encPath(path)}`, {
    method: 'PUT', body: { message, content: base64, branch: CFG.branch, sha },
  });
}

// ---------- model ----------

function parseIssue(issue) {
  const labels = issue.labels.map((l) => (typeof l === 'string' ? l : l.name));
  const type = labels.includes(TYPES.grafika) ? 'grafika' : 'napad';
  let st = 'novy';
  if (labels.includes(STATE_LABELS.zamitnuto)) st = 'zamitnuto';
  else if (labels.includes(STATE_LABELS.schvaleno)) st = 'schvaleno';
  else if (labels.includes(STATE_LABELS.diskuse)) st = 'diskuse';
  else if (issue.state === 'closed') st = 'zamitnuto';

  const body = issue.body || '';
  let meta = {};
  const m = body.match(META_RE);
  if (m) { try { meta = JSON.parse(m[1]); } catch {} }

  // obrázky vložené přímo na GitHubu (přetažením do issue)
  const external = [...body.matchAll(/!\[[^\]]*\]\((https:\/\/github\.com\/user-attachments\/[^)\s]+)\)|<img[^>]+src="(https:\/\/github\.com\/user-attachments\/[^"]+)"/g)]
    .map((x) => x[1] || x[2]);

  const desc = body
    .replace(META_RE, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<img[^>]*>/g, '')
    .replace(/^### .*$/gm, '')
    .replace(/_No response_/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    number: issue.number,
    nodeId: issue.node_id,
    title: issue.title,
    url: issue.html_url,
    author: issue.user.login,
    authorAvatar: issue.user.avatar_url,
    created: issue.created_at,
    open: issue.state === 'open',
    labels,
    type,
    state: st,
    cats: labels.filter((l) => CATS.napad.includes(l) || CATS.grafika.includes(l)),
    files: Array.isArray(meta.files) ? meta.files : [],
    external,
    meta,
    rawBody: body,
    desc,
    comments: issue.comments,
    up: issue.reactions?.['+1'] || 0,
    down: issue.reactions?.['-1'] || 0,
    reactions: null, // doplní se
  };
}

async function loadItems() {
  const [a, b] = await Promise.all([
    ghAll(`${REPO}/issues?state=all&labels=${encodeURIComponent(TYPES.napad)}`),
    ghAll(`${REPO}/issues?state=all&labels=${encodeURIComponent(TYPES.grafika)}`),
  ]);
  const seen = new Map();
  for (const i of [...a, ...b]) {
    if (i.pull_request || i.labels.some((l) => l.name === HIDDEN_LABEL)) continue;
    seen.set(i.number, i);
  }
  state.items = [...seen.values()].map(parseIssue).sort((x, y) => y.number - x.number);
  render();
  loadAllReactions();
}

async function loadReactions(item) {
  const list = await ghAll(`${REPO}/issues/${item.number}/reactions`);
  item.reactions = list.filter((r) => r.content === '+1' || r.content === '-1');
  item.up = item.reactions.filter((r) => r.content === '+1').length;
  item.down = item.reactions.filter((r) => r.content === '-1').length;
}

async function loadAllReactions() {
  for (const i of state.items) if (i.up + i.down === 0) i.reactions = [];
  const queue = state.items.filter((i) => !i.reactions);
  const worker = async () => {
    while (queue.length) {
      const it = queue.shift();
      try { await loadReactions(it); updateCard(it); } catch {}
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

const myVote = (item) => item.reactions?.find((r) => r.user.login === state.me.login);

// ---------- akce ----------

async function vote(item, content) {
  const mine = myVote(item);
  if (mine) await gh(`${REPO}/issues/${item.number}/reactions/${mine.id}`, { method: 'DELETE' });
  if (!mine || mine.content !== content) {
    await gh(`${REPO}/issues/${item.number}/reactions`, { method: 'POST', body: { content } });
  }
  await loadReactions(item);
}

async function setState(item, st, note) {
  const keep = item.labels.filter((l) => !Object.values(STATE_LABELS).includes(l));
  const labels = st === 'novy' ? keep : [...keep, STATE_LABELS[st]];
  await gh(`${REPO}/issues/${item.number}/labels`, { method: 'PUT', body: { labels } });

  const closing = st === 'schvaleno' || st === 'zamitnuto';
  if (closing || !item.open) {
    await gh(`${REPO}/issues/${item.number}`, {
      method: 'PATCH',
      body: closing
        ? { state: 'closed', state_reason: st === 'schvaleno' ? 'completed' : 'not_planned' }
        : { state: 'open' },
    });
  }
  if (note) await gh(`${REPO}/issues/${item.number}/comments`, { method: 'POST', body: { body: note } });
}

async function approveArt(item) {
  const src = item.files[item.files.length - 1];
  if (!src) return null;
  const cat = item.cats.find((c) => CATS.grafika.includes(c)) || 'ostatni';
  const ext = src.split('.').pop();
  const dest = `docs/art/${ART_DIR[cat] || 'ostatni'}/${slug(item.title)}.${ext}`;
  const b64 = await blobToBase64(await repoImage(src));
  await putFile(dest, b64, `Schváleno z nástěnky: ${item.title} (#${item.number})`);
  return dest;
}

async function deleteItem(item) {
  if (!state.admin) {
    // Bez práv správce GitHub mazání issue nedovolí, takže se jen zavře a skryje.
    await gh(`${REPO}/issues/${item.number}/comments`, {
      method: 'POST', body: { body: `🗑 Smazáno z nástěnky (${nameOf(state.me.login)}).` },
    });
    await gh(`${REPO}/issues/${item.number}/labels`, { method: 'POST', body: { labels: [HIDDEN_LABEL] } });
    await gh(`${REPO}/issues/${item.number}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'not_planned' } });
    return;
  }
  for (const path of item.files) {
    try {
      const { sha } = await gh(`${REPO}/contents/${encPath(path)}?ref=${CFG.branch}`);
      await gh(`${REPO}/contents/${encPath(path)}`, {
        method: 'DELETE', body: { message: `Nástěnka: smazán návrh #${item.number}`, sha, branch: CFG.branch },
      });
    } catch (e) { if (e.status !== 404) throw e; }
  }
  const res = await gh('/graphql', {
    method: 'POST',
    body: { query: 'mutation($id: ID!) { deleteIssue(input: { issueId: $id }) { clientMutationId } }', variables: { id: item.nodeId } },
  });
  if (res.errors?.length) throw new Error(res.errors[0].message);
}

async function uploadImages(files, dir, startAt = 1) {
  const paths = [];
  for (const [i, f] of files.entries()) {
    const ext = (f.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
    const path = `${dir}/v${startAt + i}.${ext}`;
    await putFile(path, await fileToBase64(f), `Nástěnka: obrázek ${path}`);
    paths.push(path);
  }
  return paths;
}

function buildBody(desc, meta) {
  const imgs = (meta.files || [])
    .map((p, i) => `![v${i + 1}](https://github.com/${CFG.owner}/${CFG.repo}/blob/${CFG.branch}/${encPath(p)}?raw=true)`)
    .join('\n');
  return [desc.trim(), imgs, `<!-- nastenka ${JSON.stringify(meta)} -->`].filter(Boolean).join('\n\n');
}

async function createItem({ type, title, desc, cat, files }) {
  const meta = {};
  if (files.length) {
    const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const dir = `board/navrhy/${d}-${slug(title)}-${Math.random().toString(36).slice(2, 6)}`;
    meta.files = await uploadImages(files, dir);
  }
  const labels = [TYPES[type], cat].filter(Boolean);
  return gh(`${REPO}/issues`, { method: 'POST', body: { title, body: buildBody(desc, meta), labels } });
}

async function addVersion(item, file, note) {
  const dir = item.files.length ? item.files[0].split('/').slice(0, -1).join('/')
    : `board/navrhy/${item.number}-${slug(item.title)}`;
  const [path] = await uploadImages([file], dir, item.files.length + 1);
  const meta = { ...item.meta, files: [...item.files, path] };
  const desc = item.rawBody.replace(META_RE, '').replace(/!\[v\d+\]\([^)]*\)/g, '').trim();
  await gh(`${REPO}/issues/${item.number}`, { method: 'PATCH', body: { body: buildBody(desc, meta) } });
  await gh(`${REPO}/issues/${item.number}/comments`, {
    method: 'POST', body: { body: `🖼️ Nová verze **v${meta.files.length}**${note ? `\n\n${note}` : ''}` },
  });
}

// ---------- vykreslení seznamu ----------

function visible() {
  return state.items.filter((i) =>
    (state.tab === 'vse' || i.type === state.tab) &&
    state.states.has(i.state) &&
    (!state.cat || i.cats.includes(state.cat)));
}

function imgEl(path, attrs = {}) {
  const img = h('img', { alt: '', ...attrs });
  repoImage(path).then((b) => (img.src = URL.createObjectURL(b))).catch(() => (img.alt = '⚠ obrázek se nenačetl'));
  return img;
}

// Pixel art se zvětšuje jen celými násobky, jinak se pixely rozmažou do nestejných velikostí.
function fitPixels(img, fill) {
  img.addEventListener('load', () => {
    const box = img.parentElement.getBoundingClientRect();
    const k = Math.min(box.width * fill / img.naturalWidth, box.height * fill / img.naturalHeight);
    img.style.width = img.naturalWidth * (k >= 1 ? Math.floor(k) : k) + 'px';
  });
  return img;
}

function votersEl(item) {
  const wrap = h('span', { class: 'voters' });
  for (const r of item.reactions || []) {
    wrap.append(h('img', { src: r.user.avatar_url + '&s=40', class: r.content === '+1' ? 'up' : 'down', title: `${nameOf(r.user.login)} ${r.content === '+1' ? '👍' : '👎'}` }));
  }
  return wrap;
}

function cardEl(item) {
  const cover = item.files[item.files.length - 1];
  const thumb = cover
    ? h('div', { class: 'thumb bg-check' }, fitPixels(imgEl(cover), 0.8))
    : item.external[0]
      ? h('div', { class: 'thumb bg-check' }, h('img', { src: item.external[0], alt: '' }))
      : h('p', { class: 'text-thumb' }, item.desc || '—');
  return h('button', { class: 'card', 'data-n': item.number, onclick: () => openDetail(item) },
    thumb,
    h('div', { class: 'body' },
      h('div', { class: 'tags' },
        h('span', { class: `badge ${item.state}` }, STATE_NAMES[item.state]),
        item.type === 'grafika' && h('span', { class: 'badge' }, 'grafika'),
        item.cats.map((c) => h('span', { class: 'badge' }, c)),
        item.files.length > 1 && h('span', { class: 'badge' }, `v${item.files.length}`)),
      h('h3', {}, item.title),
      h('div', { class: 'meta' },
        h('span', {}, `👍 ${item.up}`), h('span', {}, `👎 ${item.down}`),
        h('span', {}, `💬 ${item.comments}`),
        h('span', { class: 'grow' }),
        votersEl(item))));
}

function render() {
  const list = visible();
  $('#grid').replaceChildren(...list.map(cardEl));
  $('#empty').hidden = list.length > 0;
  $('#count').textContent = `${list.length} z ${state.items.length}`;
}

function updateCard(item) {
  const old = document.querySelector(`.card[data-n="${item.number}"]`);
  if (old) old.replaceWith(cardEl(item));
}

function fillCatSelect(sel, type, withAll) {
  const cats = type === 'vse' ? [...CATS.napad, ...CATS.grafika] : CATS[type];
  sel.replaceChildren(
    withAll ? h('option', { value: '' }, 'Všechny oblasti') : h('option', { value: '' }, '— bez oblasti —'),
    ...cats.map((c) => h('option', { value: c }, c)));
}

// ---------- detail ----------

const viewer = { zoom: 'fit', bg: 'bg-check', version: null, compare: '' };

async function openDetail(item) {
  const dlg = $('#detail');
  viewer.version = item.files.length - 1;
  viewer.compare = '';
  drawDetail(item);
  if (!dlg.open) dlg.showModal();
  if (!item.reactions) { await loadReactions(item).catch(() => {}); drawDetail(item); }
}

async function refreshItem(item) {
  const fresh = parseIssue(await gh(`${REPO}/issues/${item.number}`));
  Object.assign(item, fresh);
  await loadReactions(item);
  updateCard(item);
  if ($('#detail').open) drawDetail(item);
  render();
}

function stageEl(item) {
  const stage = h('div', { class: `stage ${viewer.bg}` });
  const path = item.files[viewer.version];
  const pics = [];
  if (path) pics.push({ path, cap: item.files.length > 1 ? `v${viewer.version + 1}` : null });
  if (viewer.compare) {
    const other = state.items.find((i) => String(i.number) === viewer.compare);
    const op = other?.files[other.files.length - 1];
    if (op) pics.push({ path: op, cap: other.title });
  }
  if (!path && item.external.length) {
    for (const src of item.external) stage.append(h('img', { src, alt: '', style: 'max-width:100%' }));
    return stage;
  }
  for (const p of pics) {
    const img = imgEl(p.path);
    img.addEventListener('load', () => {
      if (viewer.zoom === 'fit') {
        const box = stage.getBoundingClientRect();
        const maxW = (box.width - 48 - 24 * (pics.length - 1)) / pics.length;
        const k = Math.max(1, Math.floor(Math.min(maxW / img.naturalWidth, (box.height - 60) / img.naturalHeight)));
        img.style.width = img.naturalWidth * k + 'px';
      } else {
        img.style.width = img.naturalWidth * viewer.zoom + 'px';
      }
    });
    stage.append(h('figure', {}, img, p.cap && h('figcaption', {}, p.cap)));
  }
  return stage;
}

function seg(options, current, onPick) {
  return h('div', { class: 'seg' }, options.map(([val, label]) =>
    h('button', { class: val === current ? 'on' : '', onclick: () => onPick(val) }, label)));
}

function drawDetail(item) {
  const dlg = $('#detail');
  const hasImg = item.files.length || item.external.length;
  const redraw = () => drawDetail(item);

  let viewerEl = null;
  if (hasImg) {
    const others = state.items.filter((i) => i !== item && i.type === 'grafika' && i.files.length);
    viewerEl = h('div', { class: 'viewer' },
      stageEl(item),
      item.files.length > 0 && h('div', { class: 'toolbar' },
        seg([['fit', 'Přizpůsobit'], [1, '1×'], [2, '2×'], [4, '4×'], [8, '8×']], viewer.zoom, (v) => { viewer.zoom = v; redraw(); }),
        h('span', { class: 'row' }, ['bg-check', 'bg-dark', 'bg-light', 'bg-grass'].map((b) =>
          h('button', { class: `swatch ${b} ${viewer.bg === b ? 'on' : ''}`, title: 'Pozadí', onclick: () => { viewer.bg = b; redraw(); } }))),
        item.files.length > 1 && seg(item.files.map((_, i) => [i, `v${i + 1}`]), viewer.version, (v) => { viewer.version = v; redraw(); }),
        others.length > 0 && h('select', {
          title: 'Porovnat měřítko s jiným návrhem',
          onchange: (e) => { viewer.compare = e.target.value; redraw(); },
        }, h('option', { value: '' }, 'Porovnat s…'),
        others.map((o) => h('option', { value: o.number, selected: String(o.number) === viewer.compare }, `#${o.number} ${o.title}`)))));
  }

  const mine = myVote(item);
  const busy = (btn, fn) => async () => {
    btn.disabled = true;
    try { await fn(); } catch (e) { if (e.message !== 'Zrušeno') toast(e.message, true); } finally { btn.disabled = false; }
  };

  const upBtn = h('button', { class: `btn yes ${mine?.content === '+1' ? 'mine' : ''}` }, `👍 Pro  ${item.up}`);
  const downBtn = h('button', { class: `btn no ${mine?.content === '-1' ? 'mine' : ''}` }, `👎 Proti  ${item.down}`);
  upBtn.onclick = busy(upBtn, async () => { await vote(item, '+1'); updateCard(item); redraw(); });
  downBtn.onclick = busy(downBtn, async () => { await vote(item, '-1'); updateCard(item); redraw(); });

  const teamVotes = h('div', { class: 'team-votes' }, CFG.team.map((m) => {
    const r = item.reactions?.find((x) => x.user.login === m.login);
    return h('div', {},
      h('img', { src: `https://github.com/${m.login}.png?size=44`, alt: '' }),
      h('span', {}, m.name),
      h('span', { class: 'muted' }, r ? (r.content === '+1' ? '👍 pro' : '👎 proti') : item.reactions ? '— zatím nehlasoval' : '…'));
  }));
  const yes = item.up;
  const verdict = h('p', { class: 'muted small', style: 'margin:0' },
    `${yes} z ${CFG.team.length} pro` + (yes > CFG.team.length / 2 ? ' · většina souhlasí ✅' : ''));

  const actions = h('div', { class: 'row' });
  const act = (label, cls, st, confirmMsg, extra) => {
    const b = h('button', { class: `btn ${cls}` }, label);
    b.onclick = busy(b, async () => {
      if (confirmMsg && !confirm(confirmMsg)) return;
      let note = null;
      if (extra) note = await extra();
      await setState(item, st, note);
      toast(`#${item.number}: ${STATE_NAMES[st]}`);
      await refreshItem(item);
    });
    return b;
  };
  if (item.state !== 'schvaleno') {
    actions.append(act('✅ Schválit', 'yes', 'schvaleno',
      `Schválit „${item.title}"? (${yes} z ${CFG.team.length} pro)` +
      (item.type === 'grafika' && item.files.length ? '\nPoslední verze se uloží do docs/art/.' : ''),
      async () => {
        const dest = item.type === 'grafika' ? await approveArt(item) : null;
        return `✅ **Schváleno** na nástěnce (${nameOf(state.me.login)}, ${item.up}× pro, ${item.down}× proti).` +
          (dest ? `\n\nUloženo do \`${dest}\`.` : '\n\nDalší krok: zapsat do `docs/rozhodnuti/` a GDD.');
      }));
  }
  if (item.state !== 'diskuse') actions.append(act('💬 Do diskuse', 'talk', 'diskuse'));
  if (item.state !== 'zamitnuto') {
    actions.append(act('✖ Zamítnout', 'no', 'zamitnuto', null, async () => {
      const why = prompt('Proč zamítáme? (jedna věta, ať se o tom za měsíc nediskutuje znovu)');
      if (why === null) throw new Error('Zrušeno');
      return `✖ **Zamítnuto** (${nameOf(state.me.login)}): ${why || 'bez udání důvodu'}`;
    }));
  }
  if (item.state === 'schvaleno' || item.state === 'zamitnuto') actions.append(act('↺ Znovu otevřít', '', 'novy'));
  if (item.author === state.me.login || state.admin) {
    const del = h('button', { class: 'btn no', title: 'Smazat příspěvek' }, '🗑 Smazat');
    del.onclick = busy(del, async () => {
      const kept = item.state === 'schvaleno' && item.type === 'grafika' ? '\nSchválená kopie v docs/art/ zůstane.' : '';
      const how = state.admin ? 'Smaže se úplně i s obrázky a nejde to vrátit.' : 'Zmizí z nástěnky, na GitHubu zůstane zavřený.';
      if (!confirm(`Smazat „${item.title}"?\n${how}${kept}`)) return;
      await deleteItem(item);
      state.items = state.items.filter((i) => i !== item);
      $('#detail').close();
      render();
      toast('Smazáno');
    });
    actions.append(del);
  }

  let versionEl = null;
  if (item.type === 'grafika') {
    const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
    const btn = h('button', { class: 'btn', onclick: () => input.click() }, '⬆ Nahrát novou verzi');
    input.onchange = busy(btn, async () => {
      const f = input.files[0];
      if (!f) return;
      const note = prompt('Co se ve verzi změnilo? (nepovinné)') || '';
      await addVersion(item, f, note);
      toast('Nová verze nahrána');
      await refreshItem(item);
      viewer.version = item.files.length - 1;
      redraw();
    });
    versionEl = h('div', {}, btn, input);
  }

  const commentsEl = h('div', { class: 'comments' }, h('p', { class: 'muted small' }, 'Načítám komentáře…'));
  const ta = h('textarea', { rows: 2, placeholder: 'Napiš komentář…' });
  const send = h('button', { class: 'btn' }, 'Odeslat');
  send.onclick = busy(send, async () => {
    if (!ta.value.trim()) return;
    await gh(`${REPO}/issues/${item.number}/comments`, { method: 'POST', body: { body: ta.value.trim() } });
    ta.value = '';
    item.comments++;
    updateCard(item);
    loadComments(item, commentsEl);
  });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send.click(); });

  const side = h('div', { class: 'side' },
    h('div', { class: 'tags' },
      h('span', { class: `badge ${item.state}` }, STATE_NAMES[item.state]),
      h('span', { class: 'badge' }, item.type === 'grafika' ? 'grafika' : 'nápad'),
      item.cats.map((c) => h('span', { class: 'badge' }, c))),
    h('h2', {}, item.title),
    h('div', { class: 'muted small' },
      `#${item.number} · ${nameOf(item.author)} · ${relTime(item.created)} · `,
      h('a', { href: item.url, target: '_blank', rel: 'noopener', class: 'gh-link' }, 'otevřít na GitHubu ↗')),
    item.desc && h('p', { class: 'desc' }, item.desc),
    h('div', { class: 'vote-row' }, upBtn, downBtn),
    teamVotes,
    verdict,
    actions,
    versionEl,
    h('p', { class: 'section-title' }, 'Komentáře'),
    commentsEl,
    h('div', { class: 'comment-form' }, ta, h('div', { class: 'row end' }, h('span', { class: 'muted small' }, '⌘/Ctrl + Enter'), send)));

  dlg.replaceChildren(
    h('div', { class: `detail-grid ${hasImg ? '' : 'no-image'}`, style: 'position:relative' },
      viewerEl, side,
      h('button', { class: 'icon-btn close', title: 'Zavřít', onclick: () => dlg.close() }, '✕')));
  loadComments(item, commentsEl);
}

async function loadComments(item, el) {
  try {
    const list = await ghAll(`${REPO}/issues/${item.number}/comments`);
    el.replaceChildren(...(list.length ? list.map((c) =>
      h('div', { class: 'comment' },
        h('div', { class: 'who' }, h('img', { src: c.user.avatar_url + '&s=36', alt: '' }), nameOf(c.user.login), ' · ', relTime(c.created_at)),
        h('p', {}, c.body.replace(/\*\*/g, '').replace(/`/g, ''))))
      : [h('p', { class: 'muted small' }, 'Zatím nikdo nic nenapsal.')]));
  } catch (e) {
    el.replaceChildren(h('p', { class: 'err' }, e.message));
  }
}

// ---------- nový příspěvek ----------

const compose = { type: 'napad', files: [] };

function openCompose(type) {
  compose.type = type;
  compose.files = [];
  const f = $('#compose-form');
  f.reset();
  $('#compose-title').textContent = type === 'grafika' ? 'Nový návrh grafiky' : 'Nový nápad';
  f.elements.title.placeholder = type === 'grafika' ? 'Např. Kovář — první verze' : 'Např. Rybaření u jezera';
  fillCatSelect($('#compose-cat'), type, false);
  $('#compose-err').textContent = '';
  drawPreviews();
  $('#compose').showModal();
}

function addFiles(list) {
  for (const f of list) {
    if (!f.type.startsWith('image/')) continue;
    if (f.size > 20 * 1024 * 1024) { toast(`${f.name} je větší než 20 MB`, true); continue; }
    compose.files.push(f);
  }
  drawPreviews();
}

function drawPreviews() {
  $('#previews').replaceChildren(...compose.files.map((f, i) =>
    h('figure', {},
      h('img', { src: URL.createObjectURL(f), alt: f.name, class: 'bg-check' }),
      h('button', { type: 'button', title: 'Odebrat', onclick: () => { compose.files.splice(i, 1); drawPreviews(); } }, '×'))));
}

function setupCompose() {
  const drop = $('#drop');
  $('#pick').onclick = (e) => { e.preventDefault(); $('#files').click(); };
  $('#files').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); });
  $('#compose').addEventListener('paste', (e) => {
    const imgs = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (imgs.length) { e.preventDefault(); addFiles(imgs); }
  });

  $('#compose-form').addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'send') return;
    e.preventDefault();
    const f = e.target;
    if (compose.type === 'grafika' && !compose.files.length) {
      $('#compose-err').textContent = 'Návrh grafiky potřebuje aspoň jeden obrázek.';
      return;
    }
    const btn = $('#compose-send');
    btn.disabled = true;
    btn.textContent = compose.files.length ? 'Nahrávám obrázky…' : 'Přidávám…';
    try {
      const issue = await createItem({
        type: compose.type, title: f.elements.title.value.trim(), desc: f.elements.body.value, cat: f.elements.cat.value, files: compose.files,
      });
      $('#compose').close();
      toast(`Přidáno jako #${issue.number}`);
      const item = parseIssue(issue);
      item.reactions = [];
      state.items.unshift(item);
      state.states.add('novy');
      syncChips();
      render();
    } catch (err) {
      $('#compose-err').textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Přidat';
    }
  });
}

// ---------- start ----------

function syncChips() {
  for (const b of document.querySelectorAll('#state-chips button')) b.classList.toggle('on', state.states.has(b.dataset.state));
}

function setupUi() {
  for (const b of document.querySelectorAll('#tabs button')) {
    b.onclick = () => {
      state.tab = b.dataset.tab;
      state.cat = '';
      document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
      fillCatSelect($('#cat-filter'), state.tab, true);
      render();
    };
  }
  for (const b of document.querySelectorAll('#state-chips button')) {
    b.onclick = () => {
      const s = b.dataset.state;
      state.states.has(s) ? state.states.delete(s) : state.states.add(s);
      syncChips();
      render();
    };
  }
  $('#cat-filter').onchange = (e) => { state.cat = e.target.value; render(); };
  fillCatSelect($('#cat-filter'), 'vse', true);
  $('#new-napad').onclick = () => openCompose('napad');
  $('#new-grafika').onclick = () => openCompose('grafika');
  $('#refresh').onclick = () => { imgCache.clear(); loadItems().catch((e) => toast(e.message, true)); };
  $('#me').onclick = () => {
    if (confirm('Odhlásit? Klíč se z tohoto prohlížeče smaže.')) { store(TOKEN_KEY, null); location.reload(); }
  };
  $('#detail').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  setupCompose();
}

async function login(token) {
  state.token = token;
  const me = await gh('/user');
  try {
    state.admin = !!(await gh(REPO)).permissions?.admin;
  } catch (e) {
    if (e.status === 404) throw new Error(`Účet ${me.login} nemá přístup k ${CFG.owner}/${CFG.repo}. Přijal jsi pozvánku a má klíč zaškrtnuté „repo"?`);
    throw e;
  }
  state.me = me;
  store(TOKEN_KEY, token);
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#me').src = me.avatar_url;
  $('#me').title = `${nameOf(me.login)} · kliknutím odhlásit`;
  await loadItems();
}

function showLogin(msg = '') {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-err').textContent = msg;
}

async function main() {
  $('#token-link').href = 'https://github.com/settings/tokens/new?scopes=repo&description=' + encodeURIComponent('MMO nástěnka');
  setupUi();
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try { await login($('#token').value.trim()); } catch (err) { showLogin(err.message); } finally { btn.disabled = false; }
  });
  const saved = load(TOKEN_KEY);
  if (!saved) return showLogin();
  try { await login(saved); } catch (e) {
    showLogin(e.status === 401 ? 'Klíč vypršel nebo byl zrušen. Vytvoř nový.' : e.message);
  }
}

main();
