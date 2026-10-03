// Editor map (#154) — záložka „Editor" v nástěnce.
//
// Dlaždice bere z atlasu v herním repu (board/editor/dlazdice.png + dlazdice.json, vyrábí je
// tools/dlazdice-editoru.py). Mapa se kreslí na canvas, jede zoom a posun, nástroje štětec /
// obdélník / výplň / guma / kapátko. Projekt se ukládá do prohlížeče a dá se stáhnout jako JSON,
// takže ho jde poslat Claudovi do repa a zase otevřít a upravovat.
//
// Formát projektu (ten samý se stahuje i nahrává):
//   { verze:1, nazev, sirka, vyska, dlazdice:32, zem:[index dlaždice | -1, …], objekty:[] }
// `zem` je po řádcích shora dolů. -1 = prázdno. Vrstva `objekty` je zatím vždy prázdná,
// čeká na stromy, budovy a kameny.

const ULOZISTE = 'mmo-nastenka-editor';
const ATLAS_PNG = 'board/editor/dlazdice.png';
const ATLAS_JSON = 'board/editor/dlazdice.json';
const ZOOMY = [1, 2, 3, 4, 6, 8];

const NAZVY_TYPU = {
  trava: 'Tráva', zem: 'Zem a cesty', kamen: 'Kámen', voda: 'Voda a bažina',
  les: 'Les', pole: 'Pole', ruiny: 'Ruiny', spaleniste: 'Spáleniště', prechody: 'Přechody',
};

const NASTROJE = [
  { id: 'stetec', znak: '🖌', nazev: 'Štětec (B)', klavesa: 'b' },
  { id: 'obdelnik', znak: '▭', nazev: 'Obdélník (R)', klavesa: 'r' },
  { id: 'vypln', znak: '🪣', nazev: 'Výplň (G)', klavesa: 'g' },
  { id: 'guma', znak: '🧽', nazev: 'Guma (E)', klavesa: 'e' },
  { id: 'kapatko', znak: '💧', nazev: 'Kapátko (I)', klavesa: 'i' },
  { id: 'ruka', znak: '✋', nazev: 'Posun (mezerník nebo prostřední tlačítko)', klavesa: 'h' },
];

export function vytvorEditor(api) {
  const { h, gh, repoImage, toast, encPath, CFG } = api;
  const REPO = `/repos/${CFG.owner}/${CFG.repo}`;

  const S = {
    atlas: null,          // ImageBitmap
    katalog: null,        // { dlazdice, sloupcu, polozky }
    typ: 'trava',         // otevřená záložka palety
    vybrana: null,        // index dlaždice v atlasu
    nastroj: 'stetec',
    sila: 1,              // šířka štětce v dlaždicích
    mrizka: true,
    zoom: 3,
    posunX: 0,
    posunY: 0,
    projekt: null,
    historie: [],
    budoucnost: [],
    tah: null,            // rozdělaný tah (mapa index → původní dlaždice)
    obdelnikOd: null,
    nacteno: false,
  };

  // ---------- projekt ----------

  const prazdny = (sirka, vyska, nazev = 'Nová lokace') => ({
    verze: 1, nazev, sirka, vyska, dlazdice: 32,
    zem: new Array(sirka * vyska).fill(-1), objekty: [],
  });

  function platnyProjekt(p) {
    return !!p && Number.isInteger(p.sirka) && Number.isInteger(p.vyska)
      && p.sirka > 0 && p.vyska > 0 && p.sirka * p.vyska <= 400 * 400
      && Array.isArray(p.zem) && p.zem.length === p.sirka * p.vyska;
  }

  function uloz() {
    try { localStorage.setItem(ULOZISTE, JSON.stringify(S.projekt)); } catch {}
  }

  function nacti() {
    try {
      const p = JSON.parse(localStorage.getItem(ULOZISTE) || 'null');
      if (platnyProjekt(p)) return p;
    } catch {}
    return null;
  }

  // ---------- historie ----------

  function zacniTah() { S.tah = new Map(); }

  function polozDlazdici(x, y, dlazdice) {
    const p = S.projekt;
    if (x < 0 || y < 0 || x >= p.sirka || y >= p.vyska) return false;
    const i = y * p.sirka + x;
    if (p.zem[i] === dlazdice) return false;
    if (S.tah && !S.tah.has(i)) S.tah.set(i, p.zem[i]);
    p.zem[i] = dlazdice;
    return true;
  }

  function konecTahu() {
    if (!S.tah || !S.tah.size) { S.tah = null; return; }
    S.historie.push(S.tah);
    if (S.historie.length > 60) S.historie.shift();
    S.budoucnost.length = 0;
    S.tah = null;
    uloz();
    stav();
  }

  function vrat(zasobnik, protiZasobnik) {
    const krok = zasobnik.pop();
    if (!krok) return;
    const opacny = new Map();
    for (const [i, hodnota] of krok) {
      opacny.set(i, S.projekt.zem[i]);
      S.projekt.zem[i] = hodnota;
    }
    protiZasobnik.push(opacny);
    uloz();
    kresli();
    stav();
  }

  // ---------- nástroje ----------

  function stetec(x, y, dlazdice) {
    const r = S.sila - 1;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) polozDlazdici(x + dx, y + dy, dlazdice);
  }

  /**
   * Štětec od posledního místa k novému. Mezi dvěma událostmi myši je při rychlém tahu klidně
   * deset dlaždic; bez spojení by z čáry zbyly tečky.
   */
  let posledni = null;
  function tahStetcem(x, y, dlazdice) {
    const a = posledni ?? { x, y };
    const kroku = Math.max(Math.abs(x - a.x), Math.abs(y - a.y));
    for (let k = 0; k <= kroku; k++) {
      const t = kroku ? k / kroku : 0;
      stetec(Math.round(a.x + (x - a.x) * t), Math.round(a.y + (y - a.y) * t), dlazdice);
    }
    posledni = { x, y };
  }

  function obdelnik(x0, y0, x1, y1, dlazdice) {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) polozDlazdici(x, y, dlazdice);
    }
  }

  /** Výplň souvislé plochy stejné dlaždice (vlnou, ne rekurzí — mapa může být velká). */
  function vypln(x, y, dlazdice) {
    const p = S.projekt;
    const puvodni = p.zem[y * p.sirka + x];
    if (puvodni === dlazdice) return;
    const fronta = [[x, y]];
    const videno = new Set([y * p.sirka + x]);
    while (fronta.length) {
      const [cx, cy] = fronta.pop();
      if (!polozDlazdici(cx, cy, dlazdice)) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= p.sirka || ny >= p.vyska) continue;
        const i = ny * p.sirka + nx;
        if (videno.has(i) || p.zem[i] !== puvodni) continue;
        videno.add(i);
        fronta.push([nx, ny]);
      }
    }
  }

  // ---------- kreslení ----------

  const platno = h('canvas', { class: 'ed-platno' });
  const ctx = platno.getContext('2d');

  function naMape(e) {
    const r = platno.getBoundingClientRect();
    const d = S.projekt.dlazdice * S.zoom;
    return {
      x: Math.floor((e.clientX - r.left - S.posunX) / d),
      y: Math.floor((e.clientY - r.top - S.posunY) / d),
    };
  }

  function kresliDlazdici(i, dx, dy, d) {
    const k = S.katalog;
    const sx = (i % k.sloupcu) * k.dlazdice;
    const sy = Math.floor(i / k.sloupcu) * k.dlazdice;
    ctx.drawImage(S.atlas, sx, sy, k.dlazdice, k.dlazdice, dx, dy, d, d);
  }

  function kresli() {
    const p = S.projekt;
    if (!p || !platno.width) return;
    const d = p.dlazdice * S.zoom;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#14121a';
    ctx.fillRect(0, 0, platno.width, platno.height);
    // Plocha mapy, ať je vidět, kde končí.
    ctx.fillStyle = '#1b1822';
    ctx.fillRect(S.posunX, S.posunY, p.sirka * d, p.vyska * d);
    if (!S.atlas) return;
    // Jen to, co je vidět.
    const x0 = Math.max(0, Math.floor(-S.posunX / d));
    const y0 = Math.max(0, Math.floor(-S.posunY / d));
    const x1 = Math.min(p.sirka, Math.ceil((platno.width - S.posunX) / d));
    const y1 = Math.min(p.vyska, Math.ceil((platno.height - S.posunY) / d));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = p.zem[y * p.sirka + x];
        if (i >= 0) kresliDlazdici(i, Math.round(S.posunX + x * d), Math.round(S.posunY + y * d), d);
      }
    }
    if (S.mrizka && S.zoom >= 2) {
      ctx.strokeStyle = 'rgba(255,255,255,.07)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = x0; x <= x1; x++) {
        const px = Math.round(S.posunX + x * d) + 0.5;
        ctx.moveTo(px, Math.round(S.posunY + y0 * d));
        ctx.lineTo(px, Math.round(S.posunY + y1 * d));
      }
      for (let y = y0; y <= y1; y++) {
        const py = Math.round(S.posunY + y * d) + 0.5;
        ctx.moveTo(Math.round(S.posunX + x0 * d), py);
        ctx.lineTo(Math.round(S.posunX + x1 * d), py);
      }
      ctx.stroke();
    }
    // Rám mapy.
    ctx.strokeStyle = 'rgba(242,184,75,.5)';
    ctx.lineWidth = 2;
    ctx.strokeRect(S.posunX - 1, S.posunY - 1, p.sirka * d + 2, p.vyska * d + 2);
    if (S.obdelnikOd) {
      const { x, y } = S.obdelnikOd;
      const k = S.obdelnikOd.ted;
      if (k) {
        ctx.strokeStyle = '#f2b84b';
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(S.posunX + Math.min(x, k.x) * d, S.posunY + Math.min(y, k.y) * d,
          (Math.abs(k.x - x) + 1) * d, (Math.abs(k.y - y) + 1) * d);
        ctx.setLineDash([]);
      }
    }
  }

  function prizpusob() {
    const r = platno.parentElement.getBoundingClientRect();
    platno.width = Math.max(100, Math.floor(r.width));
    platno.height = Math.max(100, Math.floor(r.height));
    kresli();
  }

  function nasted() {
    const p = S.projekt;
    const d = p.dlazdice * S.zoom;
    S.posunX = Math.round((platno.width - p.sirka * d) / 2);
    S.posunY = Math.round((platno.height - p.vyska * d) / 2);
  }

  // ---------- paleta ----------

  const paletaZalozky = h('div', { class: 'ed-zalozky' });
  const paletaMrizka = h('div', { class: 'ed-paleta' });
  const popisVybrane = h('div', { class: 'ed-vybrana muted small' }, 'Vyber dlaždici');

  function nahledDlazdice(i, velikost = 32) {
    const k = S.katalog;
    const c = h('canvas', { width: velikost, height: velikost, class: 'ed-nahled' });
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(S.atlas, (i % k.sloupcu) * k.dlazdice, Math.floor(i / k.sloupcu) * k.dlazdice,
      k.dlazdice, k.dlazdice, 0, 0, velikost, velikost);
    return c;
  }

  function kresliPaletu() {
    const typy = [...new Set(S.katalog.polozky.map((p) => p.typ))];
    paletaZalozky.replaceChildren(...typy.map((t) => h('button', {
      class: t === S.typ ? 'on' : '', onclick: () => { S.typ = t; kresliPaletu(); },
    }, NAZVY_TYPU[t] || t)));
    const polozky = S.katalog.polozky.filter((p) => p.typ === S.typ);
    // Přechody se drží pohromadě po sadách, ať je vidět, co k čemu patří.
    const skupiny = new Map();
    for (const p of polozky) {
      const klic = p.sada || '';
      if (!skupiny.has(klic)) skupiny.set(klic, []);
      skupiny.get(klic).push(p);
    }
    const deti = [];
    for (const [sada, kusy] of skupiny) {
      if (sada) deti.push(h('div', { class: 'ed-sada muted small' }, sada));
      deti.push(h('div', { class: 'ed-rada' }, ...kusy.map((p) => {
        const b = h('button', {
          class: `ed-dlazdice${p.i === S.vybrana ? ' on' : ''}`,
          title: `${p.jmeno}${p.role ? ` · ${p.role}` : ''}`,
          onclick: () => { S.vybrana = p.i; if (S.nastroj === 'guma' || S.nastroj === 'kapatko') S.nastroj = 'stetec'; kresliPaletu(); kresliListu(); stav(); },
        });
        b.append(nahledDlazdice(p.i, 32));
        return b;
      })));
    }
    paletaMrizka.replaceChildren(...deti);
    const v = S.katalog.polozky.find((p) => p.i === S.vybrana);
    popisVybrane.replaceChildren(v ? `${v.jmeno}${v.role ? ` · ${v.role}` : ''}` : 'Vyber dlaždici');
  }

  // ---------- lišta nástrojů ----------

  const listaNastroju = h('div', { class: 'ed-nastroje' });
  const stavovyRadek = h('div', { class: 'ed-stav muted small' });

  function kresliListu() {
    listaNastroju.replaceChildren(
      ...NASTROJE.map((n) => h('button', {
        class: `icon-btn${n.id === S.nastroj ? ' on' : ''}`, title: n.nazev,
        onclick: () => { S.nastroj = n.id; kresliListu(); },
      }, n.znak)),
      h('span', { class: 'ed-oddel' }),
      h('label', { class: 'ed-sila', title: 'Šířka štětce' }, 'šířka',
        h('input', {
          type: 'range', min: '1', max: '5', value: String(S.sila),
          oninput: (e) => { S.sila = Number(e.target.value); stav(); },
        })),
      h('span', { class: 'ed-oddel' }),
      h('button', { class: 'icon-btn', title: 'Oddálit', onclick: () => zoomuj(-1) }, '−'),
      h('button', { class: 'icon-btn', title: 'Přiblížit', onclick: () => zoomuj(1) }, '+'),
      h('button', { class: 'icon-btn', title: 'Vycentrovat', onclick: () => { nasted(); kresli(); } }, '⊙'),
      h('button', {
        class: `icon-btn${S.mrizka ? ' on' : ''}`, title: 'Mřížka',
        onclick: () => { S.mrizka = !S.mrizka; kresliListu(); kresli(); },
      }, '#'),
      h('span', { class: 'ed-oddel' }),
      h('button', { class: 'icon-btn', title: 'Zpět (Ctrl+Z)', onclick: () => vrat(S.historie, S.budoucnost) }, '↶'),
      h('button', { class: 'icon-btn', title: 'Znovu (Ctrl+Y)', onclick: () => vrat(S.budoucnost, S.historie) }, '↷'),
    );
  }

  function zoomuj(smer, sx, sy) {
    const i = ZOOMY.indexOf(S.zoom);
    const novy = ZOOMY[Math.max(0, Math.min(ZOOMY.length - 1, i + smer))];
    if (novy === S.zoom) return;
    const cx = sx ?? platno.width / 2;
    const cy = sy ?? platno.height / 2;
    // Zoom kolem kurzoru: bod pod ním zůstane na místě.
    const pomer = novy / S.zoom;
    S.posunX = Math.round(cx - (cx - S.posunX) * pomer);
    S.posunY = Math.round(cy - (cy - S.posunY) * pomer);
    S.zoom = novy;
    kresliListu();
    kresli();
    stav();
  }

  function stav() {
    const p = S.projekt;
    const pouzito = p ? p.zem.reduce((n, i) => n + (i >= 0 ? 1 : 0), 0) : 0;
    const v = S.katalog?.polozky.find((x) => x.i === S.vybrana);
    stavovyRadek.replaceChildren(
      `${p ? `${p.nazev} · ${p.sirka} × ${p.vyska} dlaždic (${p.sirka * 32} × ${p.vyska * 32} px) · položeno ${pouzito}` : ''}`
      + ` · zoom ${S.zoom}× · štětec ${S.sila}${v ? ` · ${v.jmeno}` : ''}`);
  }

  // ---------- myš a klávesy ----------

  let kresliSe = false;
  let posouvaSe = null;
  let mezernik = false;

  platno.addEventListener('contextmenu', (e) => e.preventDefault());

  platno.addEventListener('pointerdown', (e) => {
    if (!S.projekt || !S.atlas) return;
    try { platno.setPointerCapture(e.pointerId); } catch {}
    const posun = e.button === 1 || mezernik || S.nastroj === 'ruka';
    if (posun) {
      posouvaSe = { x: e.clientX - S.posunX, y: e.clientY - S.posunY };
      return;
    }
    const { x, y } = naMape(e);
    // Pravé tlačítko maže, ať se nemusí přepínat nástroj.
    const mazat = e.button === 2 || S.nastroj === 'guma';
    if (S.nastroj === 'kapatko') {
      const i = S.projekt.zem[y * S.projekt.sirka + x];
      if (i >= 0) {
        S.vybrana = i;
        S.typ = S.katalog.polozky.find((p) => p.i === i)?.typ ?? S.typ;
        S.nastroj = 'stetec';
        kresliPaletu(); kresliListu(); stav();
      }
      return;
    }
    if (S.vybrana == null && !mazat) return toast('Vyber nejdřív dlaždici v paletě');
    const dlazdice = mazat ? -1 : S.vybrana;
    if (S.nastroj === 'obdelnik') { S.obdelnikOd = { x, y, ted: { x, y }, dlazdice }; kresli(); return; }
    zacniTah();
    kresliSe = true;
    posledni = null;
    if (S.nastroj === 'vypln') { vypln(x, y, dlazdice); konecTahu(); kresliSe = false; }
    else tahStetcem(x, y, dlazdice);
    kresli();
  });

  platno.addEventListener('pointermove', (e) => {
    if (posouvaSe) {
      S.posunX = e.clientX - posouvaSe.x;
      S.posunY = e.clientY - posouvaSe.y;
      return kresli();
    }
    if (S.obdelnikOd) { S.obdelnikOd.ted = naMape(e); return kresli(); }
    if (!kresliSe) return;
    const { x, y } = naMape(e);
    tahStetcem(x, y, S.nastroj === 'guma' ? -1 : S.vybrana);
    kresli();
  });

  function pust(e) {
    if (posouvaSe) { posouvaSe = null; return; }
    if (S.obdelnikOd) {
      const o = S.obdelnikOd;
      const k = o.ted || o;
      zacniTah();
      obdelnik(o.x, o.y, k.x, k.y, o.dlazdice);
      konecTahu();
      S.obdelnikOd = null;
      return kresli();
    }
    if (!kresliSe) return;
    kresliSe = false;
    posledni = null;
    konecTahu();
  }
  platno.addEventListener('pointerup', pust);
  platno.addEventListener('pointercancel', pust);

  platno.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = platno.getBoundingClientRect();
    zoomuj(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  function klavesa(e) {
    if (koren.hidden) return;
    const vPoli = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.code === 'Space' && !vPoli) { mezernik = true; e.preventDefault(); return; }
    if (vPoli) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); return vrat(S.historie, S.budoucnost); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); return vrat(S.budoucnost, S.historie); }
    const n = NASTROJE.find((x) => x.klavesa === e.key.toLowerCase());
    if (n) { S.nastroj = n.id; kresliListu(); }
  }
  addEventListener('keydown', klavesa);
  addEventListener('keyup', (e) => { if (e.code === 'Space') mezernik = false; });
  addEventListener('resize', () => { if (!koren.hidden) prizpusob(); });

  // ---------- soubory ----------

  function stahni(jmeno, blob) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: jmeno });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const nazevSouboru = () => (S.projekt.nazev || 'lokace').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'lokace';

  function stahniProjekt() {
    stahni(`${nazevSouboru()}.json`, new Blob([JSON.stringify(S.projekt)], { type: 'application/json' }));
  }

  async function stahniObrazek() {
    const p = S.projekt;
    const c = h('canvas', { width: p.sirka * p.dlazdice, height: p.vyska * p.dlazdice });
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    const k = S.katalog;
    for (let y = 0; y < p.vyska; y++) {
      for (let x = 0; x < p.sirka; x++) {
        const i = p.zem[y * p.sirka + x];
        if (i < 0) continue;
        g.drawImage(S.atlas, (i % k.sloupcu) * k.dlazdice, Math.floor(i / k.sloupcu) * k.dlazdice,
          k.dlazdice, k.dlazdice, x * p.dlazdice, y * p.dlazdice, p.dlazdice, p.dlazdice);
      }
    }
    const blob = await new Promise((hotovo) => c.toBlob(hotovo, 'image/png'));
    stahni(`${nazevSouboru()}.png`, blob);
  }

  function otevriSoubor() {
    const vstup = h('input', { type: 'file', accept: '.json,application/json' });
    vstup.onchange = async () => {
      const f = vstup.files?.[0];
      if (!f) return;
      try {
        const p = JSON.parse(await f.text());
        if (!platnyProjekt(p)) throw new Error('tohle není projekt editoru');
        S.projekt = { objekty: [], ...p };
        S.historie.length = 0; S.budoucnost.length = 0;
        uloz(); nasted(); kresli(); stav();
        toast(`Otevřeno: ${p.nazev || f.name}`);
      } catch (e) { toast(`Nešlo otevřít: ${e.message}`, true); }
    };
    vstup.click();
  }

  function novaMapa() {
    const zadani = prompt('Nová mapa — název, šířka a výška v dlaždicích (např. „Mrtvá blata 60 40")',
      `${S.projekt?.nazev || 'Nová lokace'} ${S.projekt?.sirka || 48} ${S.projekt?.vyska || 32}`);
    if (!zadani) return;
    const kusy = zadani.trim().split(/\s+/);
    const vyska = Number(kusy.pop());
    const sirka = Number(kusy.pop());
    const nazev = kusy.join(' ') || 'Nová lokace';
    if (!Number.isInteger(sirka) || !Number.isInteger(vyska) || sirka < 4 || vyska < 4 || sirka > 400 || vyska > 400) {
      return toast('Rozměr musí být dvě celá čísla 4–400', true);
    }
    S.projekt = prazdny(sirka, vyska, nazev);
    S.historie.length = 0; S.budoucnost.length = 0;
    uloz(); nasted(); kresli(); stav();
  }

  // ---------- kostra ----------

  const panelObjektu = h('div', { class: 'ed-prazdno muted small' },
    h('p', {}, 'Objekty (stromy, budovy, kameny, ohně) sem přibydou, až jich bude víc.'),
    h('p', {}, 'Zatím je v repu jen hrstka v ', h('code', {}, 'client/src/assets/objekty/'),
      ' — až je projdeme, půjde je sem přetahovat myší a skládat do mapy.'));

  const paleta = h('aside', { class: 'ed-bok' },
    h('div', { class: 'ed-hlavni-zalozky' },
      h('button', { class: 'on', onclick: (e) => prepniBok(e.target, 'dlazdice') }, 'Dlaždice'),
      h('button', { onclick: (e) => prepniBok(e.target, 'objekty') }, 'Objekty')),
    h('div', { class: 'ed-obsah', id: 'ed-dlazdice' }, paletaZalozky, paletaMrizka, popisVybrane),
    h('div', { class: 'ed-obsah', id: 'ed-objekty', hidden: true }, panelObjektu));

  function prepniBok(tlacitko, co) {
    for (const b of paleta.querySelectorAll('.ed-hlavni-zalozky button')) b.classList.toggle('on', b === tlacitko);
    paleta.querySelector('#ed-dlazdice').hidden = co !== 'dlazdice';
    paleta.querySelector('#ed-objekty').hidden = co !== 'objekty';
  }

  const koren = h('main', { class: 'editor', id: 'editor', hidden: true },
    h('div', { class: 'ed-lista' },
      h('button', { class: 'btn', onclick: novaMapa }, '✦ Nová mapa'),
      h('button', { class: 'btn', onclick: otevriSoubor }, '📂 Otevřít'),
      h('button', { class: 'btn', onclick: stahniProjekt, title: 'Projekt .json — tohle pošli Claudovi do repa, tím se dá mapa zase otevřít' }, '💾 Stáhnout projekt'),
      h('button', { class: 'btn', onclick: stahniObrazek, title: 'Hotová lokace jako jeden obrázek' }, '🖼 Stáhnout PNG'),
      listaNastroju),
    h('div', { class: 'ed-telo' }, paleta, h('div', { class: 'ed-platno-obal' }, platno)),
    stavovyRadek);

  // ---------- načtení atlasu ----------

  async function nactiAtlas() {
    if (S.nacteno) return;
    S.nacteno = true;
    try {
      const [blob, json] = await Promise.all([
        repoImage(ATLAS_PNG),
        gh(`${REPO}/contents/${encPath(ATLAS_JSON)}?ref=${CFG.branch}`, { accept: 'application/vnd.github.raw', raw: true }).then((r) => r.json()),
      ]);
      S.atlas = await createImageBitmap(blob);
      S.katalog = json;
      S.vybrana ??= json.polozky[0]?.i ?? null;
      S.typ = json.polozky.find((p) => p.i === S.vybrana)?.typ ?? S.typ;
      kresliPaletu();
      kresli();
      stav();
    } catch (e) {
      S.nacteno = false;
      toast(`Dlaždice se nenačetly: ${e.message}`, true);
    }
  }

  // ---------- veřejné ----------

  return {
    el: koren,
    ukaz() {
      koren.hidden = false;
      if (!S.projekt) {
        S.projekt = nacti() || prazdny(48, 32);
        kresliListu();
        stav();
      }
      prizpusob();
      if (!S.atlas) { nactiAtlas().then(() => { nasted(); kresli(); }); }
      else kresli();
    },
    skryj() { koren.hidden = true; },
  };
}
