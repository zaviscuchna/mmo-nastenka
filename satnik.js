// Šatník — záložka nástěnky: každá postava v libovolné kombinaci helmy, zbroje, bot a zbraně v ruce, živě
// animovaná. Skládá se stejně jako ve hře (mmo-rpg client/src/vybavaPostavy.ts): tělo = list se zbraní v ruce
// (`zbrane/<postava>--<zbraň>.png`), nebo základní list; nad něj boty, zbroj, helma (`vybava/<postava>/<kus>.png`)
// a nakonec znovu zbraň s rukou (rozdíl listu se zbraní proti základnímu), ať ji rukáv nezakryje.
// Seznam postav, kusů a zbraní vyrábí herní repo: tools/satnik-nastenka.ts → board/satnik/satnik.json.

const SEZNAM = 'board/satnik/satnik.json';
const ULOZISTE = 'mmo-nastenka-satnik';
const S = 64;
const SLOUPCU = 6;
const ZVETSENI = 4;
const SLOTY = [['helma', 'Helma'], ['zbroj', 'Zbroj'], ['boty', 'Boty']];
const KLIC = [255, 0, 255];

// Řady listu postavy (mmo-rpg client/src/postava.ts).
const rada = (r, od = 0, pocet = 6) => Array.from({ length: pocet }, (_, i) => r * SLOUPCU + od + i);
const POHYBY = {
  stani: { nazev: 'Stání', fps: 2, smery: [['Zepředu', rada(0, 0, 2)], ['Z boku', rada(0, 4, 2)], ['Zezadu', rada(0, 2, 2)]] },
  chuze: { nazev: 'Chůze', fps: 10, smery: [['Zepředu', rada(1)], ['Z boku', rada(3)], ['Zezadu', rada(2)]] },
  utok: { nazev: 'Útok', fps: 12, smery: [['Zepředu', rada(4)], ['Z boku', rada(6)], ['Zezadu', rada(5)]] },
  zasah: { nazev: 'Zásah a smrt', fps: 6, smery: [['Zásah', rada(7, 0, 2)], ['Smrt', [...rada(7, 2, 4), 47, 47]]] },
};

function cti() {
  try { return JSON.parse(localStorage.getItem(ULOZISTE) || 'null') || {}; } catch { return {}; }
}
function zapis(val) {
  try { localStorage.setItem(ULOZISTE, JSON.stringify(val)); } catch {}
}

export function vytvorSatnik(api) {
  const { h, gh, repoImage, toast, encPath, CFG } = api;
  const REPO = `/repos/${CFG.owner}/${CFG.repo}`;

  const ulozeno = cti();
  const st = {
    data: null,
    nacitam: false,
    chyba: null,
    postava: ulozeno.postava || 'templar',
    vybava: ulozeno.vybava || {},       // postava → { helma, zbroj, boty, zbran, rarita }
    pohyb: ulozeno.pohyb || 'chuze',
    pozadi: ulozeno.pozadi || 'tmave',
    beh: true,
    list: null,                          // složený list 384 × 512 (canvas)
    otisk: '',
    nahledy: new Map(),                  // sada → složený list pro přehled sad
  };
  const obrazky = new Map();             // cesta → Promise<ImageBitmap>
  const nadZbrani = new Map();           // cesta listu se zbraní → Promise<canvas> (jen zbraň a ruka)
  const platna = [];                     // [{ ctx, snimky, list() }] animovaná plátna
  let casovac = null;
  let tik = 0;

  const koren = h('section', { class: 'satnik', hidden: true });

  function obrazek(cesta) {
    if (!obrazky.has(cesta)) {
      obrazky.set(cesta, repoImage(cesta).then((b) => createImageBitmap(b))
        .catch((e) => { obrazky.delete(cesta); throw e; }));
    }
    return obrazky.get(cesta);
  }

  const postava = () => st.data.postavy.find((p) => p.id === st.postava) || st.data.postavy[0];
  const vybava = () => (st.vybava[postava().id] ||= {});
  const kus = (slot, id) => postava().kusy[slot].find((k) => k.id === id);
  const zbran = (id) => postava().zbrane.find((z) => z.id === id);
  const uloz = () => zapis({ postava: st.postava, vybava: st.vybava, pohyb: st.pohyb, pozadi: st.pozadi });

  // ---------- skládání ----------

  /** Zbraň s rukou nad brněním: pixely listu se zbraní, které se liší od základního listu (jako hra). */
  function zbranNad(p, cesta) {
    if (!nadZbrani.has(cesta)) {
      nadZbrani.set(cesta, Promise.all([obrazek(cesta), obrazek(p.zaklad)]).then(([zb, bez]) => {
        const c = document.createElement('canvas');
        c.width = zb.width;
        c.height = zb.height;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bez, 0, 0);
        const b = ctx.getImageData(0, 0, c.width, c.height).data;
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.drawImage(zb, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height);
        const z = d.data;
        for (let i = 0; i < z.length; i += 4) {
          if (z[i + 3] === b[i + 3] && Math.abs(z[i] - b[i]) + Math.abs(z[i + 1] - b[i + 1]) + Math.abs(z[i + 2] - b[i + 2]) < 24) z[i + 3] = 0;
        }
        ctx.putImageData(d, 0, 0);
        return c;
      }));
    }
    return nadZbrani.get(cesta);
  }

  /** Vrstva v barvě rarity: purpurová (klíč) se přebarví, jinak beze změny. */
  function vRarite(img, barva) {
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height);
    const px = d.data;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(barva.slice(i, i + 2), 16));
    let zmena = false;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] && px[i] === KLIC[0] && px[i + 1] === KLIC[1] && px[i + 2] === KLIC[2]) {
        px[i] = r; px[i + 1] = g; px[i + 2] = b; zmena = true;
      }
    }
    if (zmena) ctx.putImageData(d, 0, 0);
    return c;
  }

  /** Celý list postavy v dané výbavě (canvas 384 × 512). */
  async function slozList(p, v) {
    const z = v.zbran && p.zbrane.find((x) => x.id === v.zbran);
    const barva = st.data.rarity[v.rarita || 'bezna']?.barva || '#d8d2c4';
    const telo = await obrazek(z ? z.cesta : p.zaklad);
    const kusy = await Promise.all(['boty', 'zbroj', 'helma']
      .map((slot) => p.kusy[slot].find((k) => k.id === v[slot]))
      .filter(Boolean)
      .map((k) => obrazek(k.cesta)));
    const nad = z && kusy.length ? await zbranNad(p, z.cesta) : null;
    const c = document.createElement('canvas');
    c.width = telo.width;
    c.height = telo.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(telo, 0, 0);
    for (const k of kusy) ctx.drawImage(vRarite(k, barva), 0, 0);
    if (nad) ctx.drawImage(nad, 0, 0);
    return c;
  }

  async function prestav() {
    const p = postava();
    const v = vybava();
    const otisk = JSON.stringify([p.id, v]);
    if (otisk === st.otisk && st.list) return;
    st.otisk = otisk;
    try {
      const list = await slozList(p, v);
      if (st.otisk === otisk) st.list = list;
    } catch (e) {
      toast(`Šatník: ${e.message}`, true);
    }
  }

  // ---------- animace ----------

  function kresli() {
    if (st.beh) tik++;
    for (const pl of platna) {
      const list = pl.list();
      const { ctx } = pl;
      ctx.clearRect(0, 0, S, S);
      if (!list) continue;
      const krok = Math.floor((tik * pl.fps) / 30);
      const n = pl.snimky[krok % pl.snimky.length];
      ctx.drawImage(list, (n % SLOUPCU) * S, Math.floor(n / SLOUPCU) * S, S, S, 0, 0, S, S);
    }
  }

  function spust() {
    if (!casovac) casovac = setInterval(kresli, 1000 / 30);
  }
  function zastav() {
    clearInterval(casovac);
    casovac = null;
  }

  function platno(snimky, fps, list, zvetseni = ZVETSENI) {
    const c = h('canvas', { width: S, height: S, class: 'satnik-platno' });
    c.style.width = `${S * zvetseni}px`;
    c.style.height = `${S * zvetseni}px`;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    platna.push({ ctx, snimky, fps, list });
    return c;
  }

  // ---------- vzhled ----------

  function nastav(zmena) {
    Object.assign(vybava(), zmena);
    uloz();
    vykresli();
  }

  function nahodne() {
    const p = postava();
    const los = (pole) => (Math.random() < 0.15 ? undefined : pole[Math.floor(Math.random() * pole.length)]?.id);
    nastav({ helma: los(p.kusy.helma), zbroj: los(p.kusy.zbroj), boty: los(p.kusy.boty), zbran: los(p.zbrane) });
  }

  function sadaPostavy(p, sada) {
    const v = {};
    for (const [slot] of SLOTY) v[slot] = p.kusy[slot].find((k) => k.sada === sada)?.id;
    return v;
  }

  const nazevSady = (id) => st.data.sady.find((s) => s.id === id)?.nazev || 'Ostatní';

  function volba(slot, popis, polozky, aktivni, prazdne) {
    const skupiny = new Map();
    for (const x of polozky) {
      const s = x.sada ?? '';
      if (!skupiny.has(s)) skupiny.set(s, []);
      skupiny.get(s).push(x);
    }
    return h('div', { class: 'satnik-slot' },
      h('div', { class: 'satnik-slot-hlava' }, h('b', {}, popis),
        h('span', { class: 'muted small' }, aktivni ? (polozky.find((x) => x.id === aktivni)?.nazev || '') : prazdne)),
      h('div', { class: 'satnik-volby' },
        h('button', { class: aktivni ? '' : 'on', onclick: () => nastav({ [slot]: undefined }) }, prazdne),
        ...polozky.map((x) => h('button', {
          class: x.id === aktivni ? 'on' : '',
          title: x.sada !== undefined ? `${x.nazev} · ${nazevSady(x.sada)}` : x.nazev,
          onclick: () => nastav({ [slot]: x.id }),
        }, x.nazev))));
  }

  async function prehledSad(p, mrizka) {
    // Každá sada celá na postavě, se zbraní, kterou má zrovna vybranou. Klik = obléct.
    const v = vybava();
    const sady = st.data.sady.filter((s) => SLOTY.some(([slot]) => p.kusy[slot].some((k) => k.sada === s.id)));
    for (const s of [{ id: '', nazev: 'Bez brnění' }, ...sady]) {
      const vS = { ...(s.id ? sadaPostavy(p, s.id) : {}), zbran: v.zbran, rarita: v.rarita };
      const klic = JSON.stringify([p.id, vS]);
      const bunka = h('button', {
        class: 'satnik-sada', title: `Obléct: ${s.nazev}`,
        onclick: () => nastav(s.id ? sadaPostavy(p, s.id) : { helma: undefined, zbroj: undefined, boty: undefined }),
      }, platno(POHYBY.chuze.smery[1][1], POHYBY.chuze.fps, () => st.nahledy.get(klic), 2), h('span', {}, s.nazev));
      mrizka.append(bunka);
      if (!st.nahledy.has(klic)) {
        st.nahledy.set(klic, null);
        slozList(p, vS).then((c) => st.nahledy.set(klic, c)).catch(() => st.nahledy.delete(klic));
      }
    }
  }

  function vykresli() {
    platna.length = 0;
    if (st.chyba) {
      koren.replaceChildren(h('p', { class: 'empty' }, `Šatník se nenačetl: ${st.chyba}`));
      return;
    }
    if (!st.data) {
      koren.replaceChildren(h('p', { class: 'empty' }, 'Načítám šatník…'));
      return;
    }
    const p = postava();
    const v = vybava();
    prestav();

    const pocet = (p.kusy.helma.length + 1) * (p.kusy.zbroj.length + 1) * (p.kusy.boty.length + 1) * (p.zbrane.length + 1);
    const pohyb = POHYBY[st.pohyb] || POHYBY.chuze;
    const scena = h('div', { class: `satnik-scena ${st.pozadi}` },
      ...pohyb.smery.map(([popis, snimky]) => h('figure', {},
        platno(snimky, pohyb.fps, () => st.list), h('figcaption', { class: 'muted small' }, popis))));

    const mrizka = h('div', { class: 'satnik-sady' });
    prehledSad(p, mrizka);

    koren.replaceChildren(
      h('div', { class: 'satnik-postavy' },
        ...st.data.postavy.map((x) => h('button', {
          class: x.id === p.id ? 'on' : '',
          onclick: () => { st.postava = x.id; uloz(); vykresli(); },
        }, x.nazev))),
      h('div', { class: 'satnik-telo' },
        h('div', { class: 'satnik-nahled' },
          h('div', { class: 'satnik-lista' },
            h('div', { class: 'satnik-pohyby' },
              ...Object.entries(POHYBY).map(([id, x]) => h('button', {
                class: id === st.pohyb ? 'on' : '',
                onclick: () => { st.pohyb = id; uloz(); vykresli(); },
              }, x.nazev))),
            h('button', { class: 'btn', title: 'Zastavit / pustit animaci', onclick: (e) => { st.beh = !st.beh; e.target.textContent = st.beh ? '⏸' : '▶'; } }, st.beh ? '⏸' : '▶'),
            h('button', {
              class: 'btn', title: 'Pozadí: tmavé / tráva / šachovnice',
              onclick: () => { st.pozadi = { tmave: 'trava', trava: 'sachovnice', sachovnice: 'tmave' }[st.pozadi] || 'tmave'; uloz(); vykresli(); },
            }, '◐')),
          scena,
          h('div', { class: 'satnik-akce' },
            h('button', { class: 'btn primary', onclick: nahodne }, '🎲 Náhodně'),
            h('button', { class: 'btn', onclick: () => nastav({ helma: undefined, zbroj: undefined, boty: undefined, zbran: undefined }) }, 'Svléct'),
            h('label', { class: 'small muted' }, 'Rarita ',
              h('select', { onchange: (e) => nastav({ rarita: e.target.value }) },
                ...Object.entries(st.data.rarity).map(([id, r]) => h('option', { value: id, selected: (v.rarita || 'bezna') === id }, r.nazev))))),
          h('p', { class: 'muted small' },
            `${p.nazev}: ${pocet.toLocaleString('cs-CZ')} kombinací. Skládá se stejně jako ve hře, z listů v repu (main). `,
            'Rarita přebarví jen kusy s purpurovou barvou klíče.')),
        h('div', { class: 'satnik-vyber' },
          ...SLOTY.map(([slot, popis]) => volba(slot, popis, p.kusy[slot], v[slot], 'nic')),
          volba('zbran', 'Zbraň v ruce', p.zbrane, v.zbran, p.zakladniZbran))),
      h('h3', { class: 'satnik-nadpis' }, 'Celé sady na postavě ', h('span', { class: 'muted small' }, 'klik = obléct')),
      mrizka,
    );
    kresli();
  }

  async function nacti() {
    st.nacitam = true;
    vykresli();
    try {
      const r = await gh(`${REPO}/contents/${encPath(SEZNAM)}?ref=${CFG.branch}`, { accept: 'application/vnd.github.raw', raw: true });
      st.data = await r.json();
      if (!st.data.postavy.some((p) => p.id === st.postava)) st.postava = st.data.postavy[0].id;
    } catch (e) {
      st.chyba = e.message;
    }
    st.nacitam = false;
    vykresli();
  }

  return {
    el: koren,
    ukaz() {
      koren.hidden = false;
      spust();
      if (!st.data && !st.nacitam) nacti();
      else vykresli();
    },
    skryj() {
      koren.hidden = true;
      zastav();
    },
  };
}
