// Editor map (#154) — záložka „Editor map" v nástěnce.
//
// Svět je NEKONEČNÝ: nemá okraje ani zadanou velikost, roste do všech stran včetně záporných
// souřadnic. Drží se po kusech 32 × 32 dlaždic (`KUS`): kus vznikne, až na něj něco položíš,
// a prázdné kusy se zahazují. Proto je i uložený projekt malý — jsou v něm jen kusy, ve kterých
// něco je, a každý zabalený po bězích.
//
// Dlaždice bere z atlasu v herním repu (board/editor/dlazdice.png + dlazdice.json, vyrábí je
// tools/dlazdice-editoru.py). Posun pravým (nebo prostředním) tlačítkem a mezerníkem, zoom kolečkem
// od 1/32× (dlaždice je jeden pixel, vejde se celý kraj) po 8×. Hodně oddálený svět se kreslí
// z náhledů kusů, ne po dlaždicích — po dlaždicích by to bylo přes milion kreslení na překreslení.
//
// Formát projektu (stahuje se i nahrává):
//   { verze:2, nazev, dlazdice:32, kus:32, kusy: { "cx,cy": [hodnota, kolikrát, …] }, objekty:[] }
// Hodnota = otočení × 4096 + číslo dlaždice v atlasu; -1 = prázdno. Otočení 0–3 je čtvrtotáčka
// doprava, +4 k tomu překlopení zleva doprava. Světy uložené dřív mají jen čísla dlaždic, což je
// otočení 0, takže se načtou beze změny. Starší verze 1 (mapa pevné velikosti, pole `zem`) se
// načte taky a posadí se na počátek. Vrstva `objekty` je zatím vždy prázdná, čeká na stromy,
// budovy a kameny.

const ULOZISTE = 'mmo-nastenka-editor';
const ATLAS_PNG = 'board/editor/dlazdice.png';
const ATLAS_JSON = 'board/editor/dlazdice.json';
const ZOOMY = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 3, 4, 6, 8];
const NAHLED_DO = 4;            // dlaždice 4 px a menší: kreslí se z náhledů kusů, ne po dlaždicích
const NAHLEDY_STROP = 4096;     // kolik náhledů kusů se drží v paměti (jeden je 32 × 32 px, pár kB)
const KUS = 32;                 // dlaždic na stranu jednoho kusu světa
const VYPLN_STROP = 40000;      // výplň v nekonečnu musí mít strop, jinak by běžela donekonečna
const PRAZDNO = -1;
const OTOCENI = 4096;           // o kolik se v hodnotě dlaždice posune otočení (atlas má 192 dlaždic)

const kod = (i, o) => (o ? o * OTOCENI + i : i);
const cisloDlazdice = (v) => v % OTOCENI;
const otoceniDlazdice = (v) => Math.floor(v / OTOCENI);
/** „↻90°", „⇄ ↻180°" — jak se otočení píše vedle jména dlaždice. */
function popisOtoceni(o) {
  const uhel = (o % 4) * 90;
  return `${o >= 4 ? '⇄' : ''}${uhel ? `↻${uhel}°` : ''}` || '';
}

const NAZVY_TYPU = {
  trava: 'Tráva', zem: 'Zem a cesty', kamen: 'Kámen', voda: 'Voda a bažina',
  les: 'Les', pole: 'Pole', ruiny: 'Ruiny', spaleniste: 'Spáleniště', prechody: 'Přechody',
};

const NASTROJE = [
  { id: 'stetec', znak: '🖌', nazev: 'Štětec (B)', klavesa: 'b' },
  { id: 'obdelnik', znak: '▭', nazev: 'Obdélník (R)', klavesa: 'r' },
  { id: 'vypln', znak: '🪣', nazev: 'Výplň (G) — jen uvnitř už nakresleného', klavesa: 'g' },
  { id: 'guma', znak: '🧽', nazev: 'Guma (E)', klavesa: 'e' },
  { id: 'kapatko', znak: '💧', nazev: 'Kapátko (I)', klavesa: 'i' },
  { id: 'ruka', znak: '✋', nazev: 'Posun (mezerník nebo prostřední tlačítko)', klavesa: 'h' },
];

// ---------------------------------------------------------------- svět po kusech

/** Nekonečná plocha dlaždic. Klíč kusu je „cx,cy", uvnitř je pole KUS × KUS. */
class Svet {
  constructor() { this.kusy = new Map(); }

  static vKusu(x, y) { return (((y % KUS) + KUS) % KUS) * KUS + (((x % KUS) + KUS) % KUS); }

  dej(x, y) {
    const k = this.kusy.get(`${Math.floor(x / KUS)},${Math.floor(y / KUS)}`);
    return k ? k[Svet.vKusu(x, y)] : PRAZDNO;
  }

  /** Položí dlaždici. Vrací true, když se něco změnilo. */
  poloz(x, y, dlazdice) {
    const klic = `${Math.floor(x / KUS)},${Math.floor(y / KUS)}`;
    let k = this.kusy.get(klic);
    if (!k) {
      if (dlazdice === PRAZDNO) return false;   // mazat v prázdnu nemá co
      k = new Int16Array(KUS * KUS).fill(PRAZDNO);
      this.kusy.set(klic, k);
    }
    const i = Svet.vKusu(x, y);
    if (k[i] === dlazdice) return false;
    k[i] = dlazdice;
    return true;
  }

  /** Kusy, ve kterých nic nezbylo, ať nerostou v souboru ani v paměti. */
  uklid() {
    for (const [klic, k] of this.kusy) if (k.every((v) => v === PRAZDNO)) this.kusy.delete(klic);
  }

  pocet() {
    let n = 0;
    for (const k of this.kusy.values()) for (const v of k) if (v !== PRAZDNO) n++;
    return n;
  }

  /** Nejmenší obdélník, ve kterém je všechno nakreslené; null, když je svět prázdný. */
  meze() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [klic, k] of this.kusy) {
      const [cx, cy] = klic.split(',').map(Number);
      for (let i = 0; i < k.length; i++) {
        if (k[i] === PRAZDNO) continue;
        const x = cx * KUS + (i % KUS);
        const y = cy * KUS + Math.floor(i / KUS);
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
    return x1 < x0 ? null : { x0, y0, x1, y1, sirka: x1 - x0 + 1, vyska: y1 - y0 + 1 };
  }

  /**
   * Kus se ukládá po bězích: [hodnota, kolikrát, hodnota, kolikrát, …]. Plocha jednoho povrchu je
   * většinou jeden běh, takže velký svět zůstane v souboru i v prohlížeči malý (bez toho by měl
   * každý kus přes 3 kB a tisíc kusů by localStorage přetekl).
   */
  static zabal(k) {
    const out = [];
    let hodnota = k[0];
    let kolik = 0;
    for (const v of k) {
      if (v === hodnota) { kolik++; continue; }
      out.push(hodnota, kolik);
      hodnota = v;
      kolik = 1;
    }
    out.push(hodnota, kolik);
    return out;
  }

  static rozbal(pole) {
    // Starší soubory měly kus jako 1024 čísel rovnou.
    if (pole.length === KUS * KUS) return Int16Array.from(pole, (v) => (Number.isInteger(v) ? v : PRAZDNO));
    const k = new Int16Array(KUS * KUS).fill(PRAZDNO);
    let i = 0;
    for (let n = 0; n + 1 < pole.length; n += 2) {
      const hodnota = Number.isInteger(pole[n]) ? pole[n] : PRAZDNO;
      for (let j = 0; j < pole[n + 1] && i < k.length; j++) k[i++] = hodnota;
    }
    return k;
  }

  doJson() {
    this.uklid();
    const kusy = {};
    for (const [klic, k] of this.kusy) kusy[klic] = Svet.zabal(k);
    return kusy;
  }

  static zJson(kusy) {
    const s = new Svet();
    for (const [klic, pole] of Object.entries(kusy || {})) {
      if (!/^-?\d+,-?\d+$/.test(klic) || !Array.isArray(pole) || !pole.length) continue;
      s.kusy.set(klic, Svet.rozbal(pole));
    }
    return s;
  }
}

export function vytvorEditor(api) {
  const { h, gh, repoImage, toast, encPath, CFG } = api;
  const REPO = `/repos/${CFG.owner}/${CFG.repo}`;

  const S = {
    atlas: null,          // ImageBitmap
    barvy: null,          // průměrná barva každé dlaždice (pro náhledy kusů)
    katalog: null,        // { dlazdice, sloupcu, polozky }
    typ: 'trava',         // otevřená záložka palety
    vybrana: null,        // index dlaždice v atlasu
    otoceni: 0,           // 0–3 čtvrtotáčky doprava, +4 překlopeno zleva doprava
    nastroj: 'stetec',
    sila: 1,              // šířka štětce v dlaždicích
    mrizka: true,
    zoom: 3,
    posunX: 0,
    posunY: 0,
    nazev: 'Svět',
    svet: new Svet(),
    historie: [],
    budoucnost: [],
    tah: null,            // rozdělaný tah (mapa index → původní dlaždice)
    obdelnikOd: null,
    kurzor: null,
    nacteno: false,
  };

  // ---------- projekt ----------

  function doProjektu() {
    return { verze: 2, nazev: S.nazev, dlazdice: 32, kus: KUS, kusy: S.svet.doJson(), objekty: [] };
  }

  /** Načte projekt verze 2 i starý s pevnou velikostí (verze 1) — ten se posadí na počátek. */
  function zProjektu(p) {
    if (!p || typeof p !== 'object') return null;
    if (p.kusy && typeof p.kusy === 'object') return { nazev: String(p.nazev || 'Svět'), svet: Svet.zJson(p.kusy) };
    if (Array.isArray(p.zem) && Number.isInteger(p.sirka) && p.zem.length === p.sirka * p.vyska) {
      const svet = new Svet();
      for (let i = 0; i < p.zem.length; i++) {
        if (p.zem[i] >= 0) svet.poloz(i % p.sirka, Math.floor(i / p.sirka), p.zem[i]);
      }
      return { nazev: String(p.nazev || 'Svět'), svet };
    }
    return null;
  }

  // Ukládá se se zpožděním: při tahu myší by se jinak celý svět serializoval dvacetkrát za vteřinu.
  let ulozZa = 0;
  function uloz() {
    clearTimeout(ulozZa);
    ulozZa = setTimeout(() => {
      try { localStorage.setItem(ULOZISTE, JSON.stringify(doProjektu())); }
      catch (e) { toast(`Uložení do prohlížeče selhalo: ${e.message}`, true); }
    }, 400);
  }

  function nacti() {
    try { return zProjektu(JSON.parse(localStorage.getItem(ULOZISTE) || 'null')); } catch { return null; }
  }

  // ---------- historie ----------

  /** Hodnota, která se teď pokládá: vybraná dlaždice i s nastaveným otočením. */
  function polozena() { return kod(S.vybrana, S.otoceni); }

  function zacniTah() { S.tah = new Map(); }

  function polozDlazdici(x, y, dlazdice) {
    const pred = S.svet.dej(x, y);
    if (pred === dlazdice) return false;
    const klic = `${x},${y}`;
    if (S.tah && !S.tah.has(klic)) S.tah.set(klic, pred);
    zapomenNahled(x, y);
    return S.svet.poloz(x, y, dlazdice);
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
    for (const [klic, hodnota] of krok) {
      const [x, y] = klic.split(',').map(Number);
      opacny.set(klic, S.svet.dej(x, y));
      zapomenNahled(x, y);
      S.svet.poloz(x, y, hodnota);
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

  /**
   * Výplň souvislé plochy. V nekonečném světě nejde vylít prázdno „všude", takže se jede jen
   * uvnitř už nakresleného (plus pár dlaždic okolo) a nejvýš VYPLN_STROP políček.
   */
  function vypln(x, y, dlazdice) {
    const puvodni = S.svet.dej(x, y);
    if (puvodni === dlazdice) return;
    const m = S.svet.meze();
    const okraj = 8;
    const hr = m ? { x0: m.x0 - okraj, y0: m.y0 - okraj, x1: m.x1 + okraj, y1: m.y1 + okraj }
      : { x0: x - okraj, y0: y - okraj, x1: x + okraj, y1: y + okraj };
    const fronta = [[x, y]];
    const videno = new Set([`${x},${y}`]);
    let kolik = 0;
    while (fronta.length) {
      const [cx, cy] = fronta.pop();
      if (polozDlazdici(cx, cy, dlazdice)) kolik++;
      if (kolik >= VYPLN_STROP) { toast(`Výplň zastavena na ${VYPLN_STROP} dlaždicích`, true); break; }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < hr.x0 || ny < hr.y0 || nx > hr.x1 || ny > hr.y1) continue;
        const klic = `${nx},${ny}`;
        if (videno.has(klic) || S.svet.dej(nx, ny) !== puvodni) continue;
        videno.add(klic);
        fronta.push([nx, ny]);
      }
    }
  }

  // ---------- kreslení ----------

  const platno = h('canvas', { class: 'ed-platno' });
  const ctx = platno.getContext('2d');

  function naMape(e) {
    const r = platno.getBoundingClientRect();
    const d = 32 * S.zoom;
    return {
      x: Math.floor((e.clientX - r.left - S.posunX) / d),
      y: Math.floor((e.clientY - r.top - S.posunY) / d),
    };
  }

  const nahledy = new Map();      // „cx,cy" → canvas s náhledem kusu (prázdný kus: null)

  /** Průměrná barva každé dlaždice: celý atlas zmenšený na jeden pixel na dlaždici. */
  function barvyDlazdic() {
    if (S.barvy) return S.barvy;
    const k = S.katalog;
    const sloupcu = k.sloupcu;
    const radku = Math.ceil(S.atlas.height / k.dlazdice);
    const c = h('canvas', { width: sloupcu, height: radku });
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.drawImage(S.atlas, 0, 0, sloupcu, radku);
    S.barvy = g.getImageData(0, 0, sloupcu, radku).data;
    return S.barvy;
  }

  /**
   * Kus světa (32 × 32 dlaždic) jako obrázek 32 × 32 px, pixel na dlaždici — dlaždice je v něm
   * jen svou průměrnou barvou, jako na minimapě. Při velkém oddálení se jeden kus nakreslí jedním
   * drawImage místo tisíce, takže i svět o stovkách kusů jde plynule oddálit a posouvat. Náhled se
   * zahodí, jak se v kusu něco změní.
   */
  function nahledKusu(klic) {
    if (nahledy.has(klic)) return nahledy.get(klic);
    const kus = S.svet.kusy.get(klic);
    let c = null;
    if (kus) {
      const barvy = barvyDlazdic();
      c = h('canvas', { width: KUS, height: KUS });   // pixel na dlaždici
      const g = c.getContext('2d');
      const obraz = g.createImageData(KUS, KUS);
      for (let i = 0; i < kus.length; i++) {
        const v = kus[i];
        if (v < 0) continue;                 // prázdno zůstane průhledné
        const b = cisloDlazdice(v) * 4;    // otočení barvu nemění
        obraz.data.set(barvy.subarray(b, b + 4), i * 4);
      }
      g.putImageData(obraz, 0, 0);
    }
    if (nahledy.size >= NAHLEDY_STROP) nahledy.delete(nahledy.keys().next().value);
    nahledy.set(klic, c);
    return c;
  }

  function zapomenNahled(x, y) { nahledy.delete(`${Math.floor(x / KUS)},${Math.floor(y / KUS)}`); }

  /** Nakreslí hodnotu ze světa (dlaždice i s otočením) do zadaného plátna. */
  function kresliDlazdiciDo(g, v, dx, dy, d) {
    const k = S.katalog;
    const i = cisloDlazdice(v);
    const o = otoceniDlazdice(v);
    const sx = (i % k.sloupcu) * k.dlazdice;
    const sy = Math.floor(i / k.sloupcu) * k.dlazdice;
    if (!o) { g.drawImage(S.atlas, sx, sy, k.dlazdice, k.dlazdice, dx, dy, d, d); return; }
    g.save();
    g.translate(dx + d / 2, dy + d / 2);
    if (o >= 4) g.scale(-1, 1);             // překlopení, až po něm se otáčí
    g.rotate((o % 4) * Math.PI / 2);
    g.drawImage(S.atlas, sx, sy, k.dlazdice, k.dlazdice, -d / 2, -d / 2, d, d);
    g.restore();
  }

  const kresliDlazdici = (v, dx, dy, d) => kresliDlazdiciDo(ctx, v, dx, dy, d);

  function kresli() {
    if (!platno.width) return;
    const d = 32 * S.zoom;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#14121a';
    ctx.fillRect(0, 0, platno.width, platno.height);
    if (!S.atlas) return;
    // Jen to, co je vidět. Svět nemá okraje, takže se jede od kraje obrazovky ke kraji.
    const x0 = Math.floor(-S.posunX / d);
    const y0 = Math.floor(-S.posunY / d);
    const x1 = Math.ceil((platno.width - S.posunX) / d);
    const y1 = Math.ceil((platno.height - S.posunY) / d);
    if (d <= NAHLED_DO) {
      kresliZNahledu(x0, y0, x1, y1, d);
    } else {
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = S.svet.dej(x, y);
          if (i >= 0) kresliDlazdici(i, Math.round(S.posunX + x * d), Math.round(S.posunY + y * d), d);
        }
      }
    }
    if (S.mrizka && S.zoom >= 2) {
      ctx.strokeStyle = 'rgba(255,255,255,.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = x0; x <= x1; x++) {
        const px = Math.round(S.posunX + x * d) + 0.5;
        ctx.moveTo(px, 0); ctx.lineTo(px, platno.height);
      }
      for (let y = y0; y <= y1; y++) {
        const py = Math.round(S.posunY + y * d) + 0.5;
        ctx.moveTo(0, py); ctx.lineTo(platno.width, py);
      }
      ctx.stroke();
    }
    // Osy světa: v nekonečnu je dobré vidět, kde je počátek 0,0.
    ctx.strokeStyle = 'rgba(242,184,75,.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(S.posunX) + 0.5, 0); ctx.lineTo(Math.round(S.posunX) + 0.5, platno.height);
    ctx.moveTo(0, Math.round(S.posunY) + 0.5); ctx.lineTo(platno.width, Math.round(S.posunY) + 0.5);
    ctx.stroke();
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

  /** Hodně oddálený svět: jeden kus = jedno drawImage z náhledu, dlaždice je jen barevný čtvereček. */
  function kresliZNahledu(x0, y0, x1, y1, d) {
    const dk = KUS * d;               // pixelů na kus (při 1/32× je to 32, tedy náhled 1 : 1)
    for (let cy = Math.floor(y0 / KUS); cy <= Math.floor((y1 - 1) / KUS); cy++) {
      for (let cx = Math.floor(x0 / KUS); cx <= Math.floor((x1 - 1) / KUS); cx++) {
        const n = nahledKusu(`${cx},${cy}`);
        if (n) ctx.drawImage(n, Math.round(S.posunX + cx * dk), Math.round(S.posunY + cy * dk), dk, dk);
      }
    }
  }

  function prizpusob() {
    const r = platno.parentElement.getBoundingClientRect();
    platno.width = Math.max(100, Math.floor(r.width));
    platno.height = Math.max(100, Math.floor(r.height));
    kresli();
  }

  /** Oddálí tak, aby se celé nakreslené vešlo na plátno, a posadí to doprostřed. */
  function celySvet() {
    const m = S.svet.meze();
    if (m) {
      const sirka = Math.max(1, platno.width - 48);
      const vyska = Math.max(1, platno.height - 48);
      let z = ZOOMY[0];
      for (const v of ZOOMY) if (m.sirka * 32 * v <= sirka && m.vyska * 32 * v <= vyska) z = v;
      S.zoom = z;
    }
    nasted();
    kresliListu();
    kresli();
    stav();
  }

  /** Doprostřed obrazovky dá buď nakreslené, nebo počátek světa, když je prázdný. */
  function nasted() {
    const m = S.svet.meze();
    const d = 32 * S.zoom;
    const sx = m ? m.x0 + m.sirka / 2 : 0;
    const sy = m ? m.y0 + m.vyska / 2 : 0;
    S.posunX = Math.round(platno.width / 2 - sx * d);
    S.posunY = Math.round(platno.height / 2 - sy * d);
  }

  // ---------- paleta ----------

  const paletaZalozky = h('div', { class: 'ed-zalozky' });
  const paletaMrizka = h('div', { class: 'ed-paleta' });
  const popisVybrane = h('div', { class: 'ed-vybrana muted small' }, 'Vyber dlaždici');
  const otoceniRada = h('div', { class: 'ed-otoceni' });

  /** Otočení platí pro další pokládání, ne pro už nakreslené — jako štětec, ne jako guma. */
  function otoc(smer) {
    S.otoceni = (S.otoceni & 4) + ((S.otoceni % 4) + smer + 4) % 4;
    kresliOtoceni(); stav();
  }

  function preklop() {
    S.otoceni = S.otoceni >= 4 ? S.otoceni - 4 : S.otoceni + 4;
    kresliOtoceni(); stav();
  }

  function kresliOtoceni() {
    const mam = S.katalog?.polozky.some((p) => p.i === S.vybrana);
    otoceniRada.replaceChildren(
      mam ? nahledDlazdice(S.vybrana, 48, S.otoceni) : h('span', { class: 'muted small' }, '—'),
      h('div', { class: 'ed-otoceni-tlacitka' },
        h('button', { class: 'icon-btn', title: 'Otočit doprava (O)', onclick: () => otoc(1) }, '↻'),
        h('button', { class: 'icon-btn', title: 'Otočit doleva (Shift+O)', onclick: () => otoc(-1) }, '↺'),
        h('button', {
          class: `icon-btn${S.otoceni >= 4 ? ' on' : ''}`, title: 'Překlopit zleva doprava (X)', onclick: preklop,
        }, '⇄')),
      h('span', { class: 'muted small' }, S.otoceni ? `pokládá se ${popisOtoceni(S.otoceni)}` : 'bez otočení'));
  }

  function nahledDlazdice(i, velikost = 32, o = 0) {
    const c = h('canvas', { width: velikost, height: velikost, class: 'ed-nahled' });
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    kresliDlazdiciDo(g, kod(i, o), 0, 0, velikost);
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
    kresliOtoceni();
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
      h('button', { class: 'icon-btn', title: 'Na nakreslené (prázdný svět: na počátek 0,0)', onclick: () => { nasted(); kresli(); } }, '⊙'),
      h('button', { class: 'icon-btn', title: 'Celý svět na obrazovku (F)', onclick: celySvet }, '⤢'),
      h('button', {
        class: `icon-btn${S.mrizka ? ' on' : ''}`, title: 'Mřížka',
        onclick: () => { S.mrizka = !S.mrizka; kresliListu(); kresli(); },
      }, '#'),
      h('span', { class: 'ed-oddel' }),
      h('button', { class: 'icon-btn', title: 'Zpět (Ctrl+Z)', onclick: () => vrat(S.historie, S.budoucnost) }, '↶'),
      h('button', { class: 'icon-btn', title: 'Znovu (Ctrl+Y)', onclick: () => vrat(S.budoucnost, S.historie) }, '↷'),
    );
  }

  /** 8× nebo 1/8× — zlomek se píše jako zlomek, ať se to dá přečíst. */
  function popisZoomu(z) { return z >= 1 ? `${z}×` : `1/${Math.round(1 / z)}×`; }

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
    const m = S.svet.meze();
    const v = S.katalog?.polozky.find((x) => x.i === S.vybrana);
    const rozsah = m
      ? `${m.sirka} × ${m.vyska} dlaždic (od ${m.x0},${m.y0} do ${m.x1},${m.y1}) · položeno ${S.svet.pocet()}`
      : 'zatím prázdný svět';
    stavovyRadek.replaceChildren(
      `${S.nazev} · ${rozsah} · zoom ${popisZoomu(S.zoom)} · štětec ${S.sila}`
      + `${v ? ` · ${v.jmeno}${S.otoceni ? ` ${popisOtoceni(S.otoceni)}` : ''}` : ''}`
      + `${S.kurzor ? ` · kurzor ${S.kurzor.x},${S.kurzor.y}` : ''}`);
  }

  // ---------- myš a klávesy ----------

  let kresliSe = false;
  let posouvaSe = null;
  let mezernik = false;

  platno.addEventListener('contextmenu', (e) => e.preventDefault());

  platno.addEventListener('pointerdown', (e) => {
    if (!S.atlas) return;
    try { platno.setPointerCapture(e.pointerId); } catch {}
    // Posun: pravé i prostřední tlačítko, mezerník nebo nástroj ruka. Táhne se kamkoli, svět nemá
    // okraje. Mazání zůstává na gumě (E), ať se posun a mazání nepletou.
    if (e.button === 2 || e.button === 1 || mezernik || S.nastroj === 'ruka') {
      posouvaSe = { x: e.clientX - S.posunX, y: e.clientY - S.posunY };
      return;
    }
    const { x, y } = naMape(e);
    const mazat = S.nastroj === 'guma';
    if (S.nastroj === 'kapatko') {
      const v = S.svet.dej(x, y);
      if (v >= 0) {
        S.vybrana = cisloDlazdice(v);
        S.otoceni = otoceniDlazdice(v);     // kapátko bere dlaždici i s otočením
        S.typ = S.katalog.polozky.find((p) => p.i === S.vybrana)?.typ ?? S.typ;
        S.nastroj = 'stetec';
        kresliPaletu(); kresliListu(); stav();
      }
      return;
    }
    if (S.vybrana == null && !mazat) return toast('Vyber nejdřív dlaždici v paletě');
    const dlazdice = mazat ? PRAZDNO : polozena();
    if (S.nastroj === 'obdelnik') { S.obdelnikOd = { x, y, ted: { x, y }, dlazdice }; kresli(); return; }
    zacniTah();
    kresliSe = true;
    posledni = null;
    if (S.nastroj === 'vypln') { vypln(x, y, dlazdice); konecTahu(); kresliSe = false; }
    else tahStetcem(x, y, dlazdice);
    kresli();
  });

  platno.addEventListener('pointermove', (e) => {
    S.kurzor = naMape(e);
    if (posouvaSe) {
      S.posunX = e.clientX - posouvaSe.x;
      S.posunY = e.clientY - posouvaSe.y;
      return kresli();
    }
    if (S.obdelnikOd) { S.obdelnikOd.ted = S.kurzor; return kresli(); }
    if (!kresliSe) return pozdejiStav();
    tahStetcem(S.kurzor.x, S.kurzor.y, S.nastroj === 'guma' ? PRAZDNO : polozena());
    kresli();
  });

  // Souřadnice kurzoru se dopisuje se zpožděním: počítat meze světa při každém pohybu myši je zbytečné.
  let stavZa = 0;
  function pozdejiStav() {
    clearTimeout(stavZa);
    stavZa = setTimeout(stav, 120);
  }

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
    if (e.key.toLowerCase() === 'f') { e.preventDefault(); return celySvet(); }
    if (e.key.toLowerCase() === 'o') { e.preventDefault(); return otoc(e.shiftKey ? -1 : 1); }
    if (e.key.toLowerCase() === 'x') { e.preventDefault(); return preklop(); }
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

  const nazevSouboru = () => (S.nazev || 'svet').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'svet';

  function stahniProjekt() {
    stahni(`${nazevSouboru()}.json`, new Blob([JSON.stringify(doProjektu())], { type: 'application/json' }));
  }

  /** Vyveze nakreslenou část světa: ořízne se na meze, prázdno kolem se zahodí. */
  async function stahniObrazek() {
    const m = S.svet.meze();
    if (!m) return toast('Svět je prázdný, není co vyvézt', true);
    const w = m.sirka * 32;
    const v = m.vyska * 32;
    if (w * v > 80e6) return toast(`Obrázek by měl ${w} × ${v} px, to prohlížeč neutáhne`, true);
    const c = h('canvas', { width: w, height: v });
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    for (let y = m.y0; y <= m.y1; y++) {
      for (let x = m.x0; x <= m.x1; x++) {
        const hodnota = S.svet.dej(x, y);
        if (hodnota < 0) continue;
        kresliDlazdiciDo(g, hodnota, (x - m.x0) * 32, (y - m.y0) * 32, 32);
      }
    }
    const blob = await new Promise((hotovo) => c.toBlob(hotovo, 'image/png'));
    stahni(`${nazevSouboru()}.png`, blob);
    toast(`Vyvezeno ${m.sirka} × ${m.vyska} dlaždic, levý horní roh je ${m.x0},${m.y0}`);
  }

  function otevriSoubor() {
    const vstup = h('input', { type: 'file', accept: '.json,application/json' });
    vstup.onchange = async () => {
      const f = vstup.files?.[0];
      if (!f) return;
      try {
        const nacteny = zProjektu(JSON.parse(await f.text()));
        if (!nacteny) throw new Error('tohle není projekt editoru');
        S.nazev = nacteny.nazev;
        S.svet = nacteny.svet;
        nahledy.clear();
        S.historie.length = 0; S.budoucnost.length = 0;
        uloz(); nasted(); kresli(); stav();
        toast(`Otevřeno: ${S.nazev}`);
      } catch (e) { toast(`Nešlo otevřít: ${e.message}`, true); }
    };
    vstup.click();
  }

  function novySvet() {
    if (S.svet.kusy.size && !confirm('Založit nový svět? Co máš rozkreslené, se ztratí — stáhni si to napřed.')) return;
    const nazev = prompt('Jak se ten svět jmenuje?', 'Svět');
    if (nazev === null) return;
    S.nazev = nazev.trim() || 'Svět';
    S.svet = new Svet();
    nahledy.clear();
    S.historie.length = 0; S.budoucnost.length = 0;
    uloz(); nasted(); kresli(); stav();
  }

  function prejmenuj() {
    const nazev = prompt('Název světa', S.nazev);
    if (nazev === null) return;
    S.nazev = nazev.trim() || 'Svět';
    uloz(); stav();
  }

  // ---------- kostra ----------

  const panelObjektu = h('div', { class: 'ed-prazdno muted small' },
    h('p', {}, 'Objekty (stromy, budovy, kameny, ohně) sem přibydou, až jich bude víc.'),
    h('p', {}, 'Zatím je v repu jen hrstka v ', h('code', {}, 'client/src/assets/objekty/'),
      ' — až je projdeme, půjde je sem přetahovat myší a skládat do světa.'));

  const paleta = h('aside', { class: 'ed-bok' },
    h('div', { class: 'ed-hlavni-zalozky' },
      h('button', { class: 'on', onclick: (e) => prepniBok(e.target, 'dlazdice') }, 'Dlaždice'),
      h('button', { onclick: (e) => prepniBok(e.target, 'objekty') }, 'Objekty')),
    h('div', { class: 'ed-obsah', id: 'ed-dlazdice' }, paletaZalozky, paletaMrizka, popisVybrane, otoceniRada),
    h('div', { class: 'ed-obsah', id: 'ed-objekty', hidden: true }, panelObjektu));

  function prepniBok(tlacitko, co) {
    for (const b of paleta.querySelectorAll('.ed-hlavni-zalozky button')) b.classList.toggle('on', b === tlacitko);
    paleta.querySelector('#ed-dlazdice').hidden = co !== 'dlazdice';
    paleta.querySelector('#ed-objekty').hidden = co !== 'objekty';
  }

  const koren = h('main', { class: 'editor', id: 'editor', hidden: true },
    h('div', { class: 'ed-lista' },
      h('button', { class: 'btn', onclick: novySvet }, '✦ Nový svět'),
      h('button', { class: 'btn', onclick: prejmenuj, title: 'Přejmenovat svět' }, '✎ Název'),
      h('button', { class: 'btn', onclick: otevriSoubor }, '📂 Otevřít'),
      h('button', { class: 'btn', onclick: stahniProjekt, title: 'Projekt .json — tohle pošli Claudovi do repa, tím se dá svět zase otevřít' }, '💾 Stáhnout projekt'),
      h('button', { class: 'btn', onclick: stahniObrazek, title: 'Nakreslená část světa jako jeden obrázek' }, '🖼 Stáhnout PNG'),
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
      S.barvy = null;
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

  let zalozeno = false;
  return {
    el: koren,
    ukaz() {
      koren.hidden = false;
      if (!zalozeno) {
        zalozeno = true;
        const ulozeny = nacti();
        if (ulozeny) { S.nazev = ulozeny.nazev; S.svet = ulozeny.svet; nahledy.clear(); }
        kresliListu();
        stav();
      }
      prizpusob();
      if (!S.atlas) nactiAtlas().then(() => { nasted(); kresli(); });
      else kresli();
    },
    skryj() { koren.hidden = true; },
  };
}
