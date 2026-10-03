// Editor map (#154) — záložka „Editor map" v nástěnce.
//
// Svět je NEKONEČNÝ: nemá okraje ani zadanou velikost, roste do všech stran včetně záporných
// souřadnic. Drží se po kusech 32 × 32 dlaždic (`KUS`): kus vznikne, až na něj něco položíš,
// a prázdné kusy se zahazují. Proto je i uložený projekt malý — jsou v něm jen kusy, ve kterých
// něco je, a každý zabalený po bězích.
//
// Dlaždice bere z atlasu v herním repu (board/editor/dlazdice.png + dlazdice.json, vyrábí je
// tools/dlazdice-editoru.py). Posun pravým (nebo prostředním) tlačítkem a mezerníkem, zoom kolečkem
// od 1/32× (dlaždice je jeden pixel, vejde se celý kraj) po 8×, po krocích kolem 1,5×. Hodně oddálený svět se kreslí
// z náhledů kusů, ne po dlaždicích — po dlaždicích by to bylo přes milion kreslení na překreslení.
//
// Objekty (stromy, domy, cesty, ploty) jsou druhá vrstva: nesedí na mřížce, leží v ní, kam je
// člověk přetáhne. Katalog i obrázek jsou zase v herním repu (board/editor/objekty.png + .json,
// vyrábí tools/objekty-editoru.py) a stahují se, až jsou potřeba — mají pár megabajtů.
//
// Formát projektu (stahuje se i nahrává):
//   { verze:2, nazev, dlazdice:32, kus:32, kusy: { "cx,cy": [hodnota, kolikrát, …] }, objekty:[] }
// Hodnota = otočení × 4096 + číslo dlaždice v atlasu; -1 = prázdno. Otočení 0–3 je čtvrtotáčka
// doprava, +4 k tomu překlopení zleva doprava. Světy uložené dřív mají jen čísla dlaždic, což je
// otočení 0, takže se načtou beze změny. Starší verze 1 (mapa pevné velikosti, pole `zem`) se
// načte taky a posadí se na počátek. Vrstva `objekty` je pole `{ j: jméno z katalogu, x, y }`,
// kde x a y je **pata** objektu (spodní střed) ve světových pixelech — dlaždice má 32 px. Ukládá
// se jméno, ne číslo v atlasu, aby projekt přežil, až objektů přibude. Objekt může mít navíc
// `m` (měřítko, 1 = jak je nakreslený) a `o` (otočení 0–3 po čtvrtotáčce, +4 překlopení zleva
// doprava) a `v` (ruční pořadí: kladné dopředu, záporné dozadu, jinak se řadí podle paty)
// — zapisují se, jen když nejsou výchozí.

const ULOZISTE = 'mmo-nastenka-editor';
const ATLAS_PNG = 'board/editor/dlazdice.png';
const ATLAS_JSON = 'board/editor/dlazdice.json';
const ATLAS_OBJ_PNG = 'board/editor/objekty.png';
const ATLAS_OBJ_JSON = 'board/editor/objekty.json';
// Krok je zhruba jedenapůlnásobek, ať se dá doladit. Nad 1× jen celé násobky, aby se pixelová
// grafika zvětšovala celým číslem; pod 1× se zmenšuje, tam vadí jen to, aby dlaždice navazovaly.
const ZOOMY = [1 / 32, 1 / 24, 1 / 16, 1 / 12, 1 / 8, 1 / 6, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 1, 2, 3, 4, 5, 6, 8];
const NAHLED_DO = 6;            // dlaždice 6 px a menší: kreslí se z náhledů kusů, ne po dlaždicích
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
  { id: 'objekt', znak: '🌲', nazev: 'Objekty (A) — pokládání a posouvání', klavesa: 'a' },
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
    objAtlas: null,       // ImageBitmap atlasu objektů
    objKatalog: null,     // { sirka, vyska, nazvyTypu, polozky }
    objTyp: null,         // otevřená záložka v paletě objektů
    objVybrany: null,     // položka katalogu, která se pokládá
    objekty: [],          // položené objekty [{ j, x, y }], x a y je pata ve světových pixelech
    objOznaceny: -1,      // index v S.objekty, se kterým se zrovna pracuje
    objNacitam: false,
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
    return {
      verze: 2, nazev: S.nazev, dlazdice: 32, kus: KUS, kusy: S.svet.doJson(),
      objekty: S.objekty.map((o) => ({
        j: o.j, x: Math.round(o.x), y: Math.round(o.y),
        ...(o.m && o.m !== 1 ? { m: o.m } : {}),
        ...(o.o ? { o: o.o } : {}),
        ...(o.v ? { v: o.v } : {}),
      })),
    };
  }

  /** Objekty z projektu: jen ty, co mají jméno a čísla — zbytek je rozbitý soubor. */
  function objektyZProjektu(pole) {
    if (!Array.isArray(pole)) return [];
    return pole
      .filter((o) => o && typeof o.j === 'string' && Number.isFinite(o.x) && Number.isFinite(o.y))
      .map((o) => ({
        j: o.j, x: o.x, y: o.y,
        ...(Number.isFinite(o.m) && o.m > 0 ? { m: Math.min(8, Math.max(0.1, o.m)) } : {}),
        ...(Number.isInteger(o.o) && o.o > 0 && o.o < 8 ? { o: o.o } : {}),
        ...(Number.isFinite(o.v) && o.v !== 0 ? { v: o.v } : {}),
      }));
  }

  /** Načte projekt verze 2 i starý s pevnou velikostí (verze 1) — ten se posadí na počátek. */
  function zProjektu(p) {
    if (!p || typeof p !== 'object') return null;
    if (p.kusy && typeof p.kusy === 'object') {
      return { nazev: String(p.nazev || 'Svět'), svet: Svet.zJson(p.kusy), objekty: objektyZProjektu(p.objekty) };
    }
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
    S.historie.push({ dlazdice: S.tah });
    if (S.historie.length > 60) S.historie.shift();
    S.budoucnost.length = 0;
    S.tah = null;
    uloz();
    stav();
  }

  /** Krok historie je buď změna dlaždic (mapa místo → původní), nebo celá vrstva objektů. */
  function vrat(zasobnik, protiZasobnik) {
    const krok = zasobnik.pop();
    if (!krok) return;
    const opacny = {};
    if (krok.dlazdice) {
      const zpet = new Map();
      for (const [klic, hodnota] of krok.dlazdice) {
        const [x, y] = klic.split(',').map(Number);
        zpet.set(klic, S.svet.dej(x, y));
        zapomenNahled(x, y);
        S.svet.poloz(x, y, hodnota);
      }
      opacny.dlazdice = zpet;
    }
    if (krok.objekty) {
      opacny.objekty = S.objekty;
      S.objekty = krok.objekty;
      S.objOznaceny = -1;
      kresliPaletuObjektu();
      kresliVybrany();
    }
    protiZasobnik.push(opacny);
    uloz();
    kresli();
    stav();
  }

  /** Zapíše do historie stav vrstvy objektů PŘED změnou (voláno před každou úpravou). */
  function zmenaObjektu() {
    S.historie.push({ objekty: S.objekty.map((o) => ({ ...o })) });
    if (S.historie.length > 60) S.historie.shift();
    S.budoucnost.length = 0;
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

  // ---------- objekty ----------

  const objPodleJmena = new Map();      // jméno z katalogu → položka (kde je v atlasu)
  const UCHYT = 10;                     // velikost úchytu na zvětšování (px na obrazovce)

  /** Souřadnice ve světě v herních pixelech (dlaždice = 32 px), ne v dlaždicích. */
  function naSvet(e) {
    const r = platno.getBoundingClientRect();
    return {
      x: (e.clientX - r.left - S.posunX) / S.zoom,
      y: (e.clientY - r.top - S.posunY) / S.zoom,
    };
  }

  const MERITKA = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];

  /** Rozměr objektu na mapě po měřítku a otočení (po čtvrtotáčce si strany vymění místo). */
  function rozmerObjektu(k, o) {
    const m = o.m || 1;
    return (o.o || 0) % 2 ? { s: k.v * m, v: k.s * m } : { s: k.s * m, v: k.v * m };
  }

  /** Kusy cest sedí na mřížku vždycky, ostatní jen se Shiftem. Pata = spodní střed políčka. */
  function pripni(bod, polozka, shift) {
    if (!polozka?.naMrizku && !shift) return bod;
    return { x: Math.floor(bod.x / 32) * 32 + 16, y: Math.floor(bod.y / 32) * 32 + 32 };
  }

  /**
   * Pořadí kreslení: co je níž (větší y), je blíž ke kameře a kreslí se přes to za ním. Ručně
   * poslaný dopředu nebo dozadu (`v`) to přebije — na to je nabídka pod pravým tlačítkem.
   */
  function poradiObjektu() {
    return S.objekty.map((_, i) => i).sort((a, b) => {
      const x = S.objekty[a];
      const y = S.objekty[b];
      return (x.v || 0) - (y.v || 0) || x.y - y.y || a - b;
    });
  }

  /** Index objektu pod bodem; bere ten nejvrchnější. -1 = nic tam není. */
  function objektNa(bod) {
    const poradi = poradiObjektu();
    for (let n = poradi.length - 1; n >= 0; n--) {
      const o = S.objekty[poradi[n]];
      const k = objPodleJmena.get(o.j);
      if (!k) continue;
      const r = rozmerObjektu(k, o);
      if (bod.x >= o.x - r.s / 2 && bod.x <= o.x + r.s / 2 && bod.y <= o.y && bod.y >= o.y - r.v) {
        return poradi[n];
      }
    }
    return -1;
  }

  function polozObjekt(bod, shift) {
    if (!S.objVybrany) return -1;
    const kam = pripni(bod, S.objVybrany, shift);
    zmenaObjektu();
    S.objekty.push({ j: S.objVybrany.soubor, x: kam.x, y: kam.y });
    S.objOznaceny = S.objekty.length - 1;
    uloz();
    return S.objOznaceny;
  }

  /** Změní vybraný objekt bez zápisu do historie (na to je zmenaObjektu) a bez překreslení panelu. */
  function zmenObjekt(zmena) {
    const o = S.objekty[S.objOznaceny];
    if (!o) return false;
    zmena(o);
    if (o.m === 1) delete o.m;              // výchozí hodnoty se neukládají
    if (!o.o) delete o.o;
    if (!o.v) delete o.v;
    uloz();
    kresli();
    stav();
    return true;
  }

  /** Jedna úprava vybraného objektu i se zápisem do historie a překreslením panelu. */
  function upravVybrany(zmena) {
    if (!S.objekty[S.objOznaceny]) return false;
    zmenaObjektu();
    zmenObjekt(zmena);
    kresliVybrany();
    return true;
  }

  function otocObjekt(smer) {
    upravVybrany((o) => {
      const t = o.o || 0;
      o.o = (t & 4) + ((t % 4) + smer + 4) % 4;
    });
  }

  function preklopObjekt() {
    upravVybrany((o) => { o.o = (o.o || 0) >= 4 ? (o.o || 0) - 4 : (o.o || 0) + 4; });
  }

  function zmenMeritko(smer) {
    const o = S.objekty[S.objOznaceny];
    if (!o) return;
    const ted = o.m || 1;
    const i = MERITKA.findIndex((m) => m > ted + 1e-6);
    const dalsi = smer > 0
      ? MERITKA[i < 0 ? MERITKA.length - 1 : i]
      : [...MERITKA].reverse().find((m) => m < ted - 1e-6) ?? MERITKA[0];
    upravVybrany((x) => { x.m = dalsi; });
  }

  function doPopredi() {
    upravVybrany((o) => { o.v = Math.max(0, ...S.objekty.map((x) => x.v || 0)) + 1; });
  }

  function doPozadi() {
    upravVybrany((o) => { o.v = Math.min(0, ...S.objekty.map((x) => x.v || 0)) - 1; });
  }

  function podlePaty() {
    upravVybrany((o) => { delete o.v; });
  }

  function duplikujVybrany() {
    const o = S.objekty[S.objOznaceny];
    if (!o) return;
    zmenaObjektu();
    S.objekty.push({ ...o, x: o.x + 16, y: o.y + 16 });
    S.objOznaceny = S.objekty.length - 1;
    uloz();
    kresli();
    kresliVybrany();
    stav();
  }

  function smazOznaceny() {
    if (S.objOznaceny < 0) return;
    zmenaObjektu();
    S.objekty.splice(S.objOznaceny, 1);
    S.objOznaceny = -1;
    uloz();
    kresli();
    kresliVybrany();
    stav();
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
  function kresliDlazdiciDo(g, v, dx, dy, sirka, vyska = sirka) {
    const k = S.katalog;
    const i = cisloDlazdice(v);
    const o = otoceniDlazdice(v);
    const sx = (i % k.sloupcu) * k.dlazdice;
    const sy = Math.floor(i / k.sloupcu) * k.dlazdice;
    if (!o) { g.drawImage(S.atlas, sx, sy, k.dlazdice, k.dlazdice, dx, dy, sirka, vyska); return; }
    g.save();
    g.translate(dx + sirka / 2, dy + vyska / 2);
    if (o >= 4) g.scale(-1, 1);             // překlopení, až po něm se otáčí
    g.rotate((o % 4) * Math.PI / 2);
    const w = o % 2 ? vyska : sirka;        // po čtvrtotáčce si strany vymění místo
    const v2 = o % 2 ? sirka : vyska;
    g.drawImage(S.atlas, sx, sy, k.dlazdice, k.dlazdice, -w / 2, -v2 / 2, w, v2);
    g.restore();
  }

  const kresliDlazdici = (v, dx, dy, sirka, vyska) => kresliDlazdiciDo(ctx, v, dx, dy, sirka, vyska);

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
      // Dlaždice se kreslí od svého okraje k okraji té další. Při zoomu, co nevyjde na celé
      // pixely (třeba 1/3×), by jinak mezi nimi prosvítaly mezery.
      for (let y = y0; y < y1; y++) {
        const py = Math.round(S.posunY + y * d);
        const vyska = Math.round(S.posunY + (y + 1) * d) - py;
        for (let x = x0; x < x1; x++) {
          const v = S.svet.dej(x, y);
          if (v < 0) continue;
          const px = Math.round(S.posunX + x * d);
          kresliDlazdici(v, px, py, Math.round(S.posunX + (x + 1) * d) - px, vyska);
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
    kresliObjekty();
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
      const py = Math.round(S.posunY + cy * dk);
      const vyska = Math.round(S.posunY + (cy + 1) * dk) - py;
      for (let cx = Math.floor(x0 / KUS); cx <= Math.floor((x1 - 1) / KUS); cx++) {
        const n = nahledKusu(`${cx},${cy}`);
        if (!n) continue;
        const px = Math.round(S.posunX + cx * dk);
        ctx.drawImage(n, px, py, Math.round(S.posunX + (cx + 1) * dk) - px, vyska);
      }
    }
  }

  /** Objekty leží nad dlaždicemi. Měřítko je S.zoom: objekt je v herních pixelech jako dlaždice. */
  function kresliObjekty() {
    if (!S.objAtlas || !S.objekty.length) return;
    const m = S.zoom;
    for (const i of poradiObjektu()) {
      const o = S.objekty[i];
      const k = objPodleJmena.get(o.j);
      if (!k) continue;
      const r = rozmerObjektu(k, o);
      const sirka = Math.max(1, Math.round(r.s * m));
      const vyska = Math.max(1, Math.round(r.v * m));
      const dx = Math.round(S.posunX + o.x * m - sirka / 2);
      const dy = Math.round(S.posunY + o.y * m - vyska);
      if (dx > platno.width || dy > platno.height || dx + sirka < 0 || dy + vyska < 0) continue;
      kresliObjektDo(ctx, k, o, dx, dy, sirka, vyska);
      if (i === S.objOznaceny) {
        ctx.strokeStyle = '#f2b84b';
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(dx + 0.5, dy + 0.5, sirka - 1, vyska - 1);
        ctx.setLineDash([]);
        // Úchyt na zvětšování: čtvereček v pravém horním rohu, tahem nahoru objekt roste.
        ctx.setLineDash([]);
        ctx.fillStyle = '#f2b84b';
        ctx.fillRect(dx + sirka - UCHYT / 2, dy - UCHYT / 2, UCHYT, UCHYT);
      }
    }
  }

  /** Nakreslí objekt do daného plátna i s otočením a překlopením (měřítko je v šířce a výšce). */
  function kresliObjektDo(g, k, o, dx, dy, sirka, vyska) {
    const t = o.o || 0;
    if (!t) { g.drawImage(S.objAtlas, k.x, k.y, k.s, k.v, dx, dy, sirka, vyska); return; }
    g.save();
    g.translate(dx + sirka / 2, dy + vyska / 2);
    if (t >= 4) g.scale(-1, 1);
    g.rotate((t % 4) * Math.PI / 2);
    const w = t % 2 ? vyska : sirka;
    const v = t % 2 ? sirka : vyska;
    g.drawImage(S.objAtlas, k.x, k.y, k.s, k.v, -w / 2, -v / 2, w, v);
    g.restore();
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

  // ---------- paleta objektů ----------

  const objZalozky = h('div', { class: 'ed-zalozky' });
  const objMrizka = h('div', { class: 'ed-paleta' });
  const objPopis = h('div', { class: 'ed-vybrana muted small' }, 'Vyber objekt a přetáhni ho na mapu');

  function nahledObjektu(k, velikost = 48) {
    const c = h('canvas', { width: velikost, height: velikost, class: 'ed-nahled ed-nahled-obj' });
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    const m = Math.min(velikost / k.s, velikost / k.v);
    const sirka = Math.max(1, Math.round(k.s * m));
    const vyska = Math.max(1, Math.round(k.v * m));
    g.drawImage(S.objAtlas, k.x, k.y, k.s, k.v, Math.round((velikost - sirka) / 2), velikost - vyska, sirka, vyska);
    return c;
  }

  function vyberObjekt(k) {
    S.objVybrany = k;
    S.nastroj = 'objekt';
    kresliListu();
    kresliPaletuObjektu();
    stav();
  }

  /** Přetažení z palety: pod kurzorem jede duch objektu a pustit se dá rovnou na mapu. */
  function zacniZPalety(e, k) {
    vyberObjekt(k);
    const m = Math.min(Math.max(S.zoom, 0.5), 2);
    const duch = h('canvas', {
      width: Math.max(1, Math.round(k.s * m)), height: Math.max(1, Math.round(k.v * m)), class: 'ed-duch',
    });
    const g = duch.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(S.objAtlas, k.x, k.y, k.s, k.v, 0, 0, duch.width, duch.height);
    document.body.append(duch);
    const posun = (ev) => {
      duch.style.left = `${ev.clientX}px`;
      duch.style.top = `${ev.clientY}px`;
    };
    const konec = (ev) => {
      removeEventListener('pointermove', posun);
      duch.remove();
      const r = platno.getBoundingClientRect();
      const nadMapou = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      if (nadMapou) {
        polozObjekt(naSvet(ev), ev.shiftKey);
        kresli();
        kresliVybrany();
        stav();
      }
    };
    posun(e);
    addEventListener('pointermove', posun);
    addEventListener('pointerup', konec, { once: true });
  }

  const panelVybraneho = h('div', { class: 'ed-vybrany' });

  /** Co se dá s položeným objektem dělat: velikost, otočení, překlopení, kopie, poloha, smazání. */
  function kresliVybrany() {
    const o = S.objekty[S.objOznaceny];
    const k = o && objPodleJmena.get(o.j);
    if (!o || !k) {
      panelVybraneho.replaceChildren(h('span', { class: 'muted small' },
        'Nic není vybrané. Klikni na objekt na mapě a půjde zvětšit, otočit nebo posunout.'));
      return;
    }
    const m = o.m || 1;
    const cislo = (klic, popis) => h('label', { class: 'ed-cislo' }, popis,
      h('input', {
        type: 'number', step: '1', value: String(Math.round(o[klic])),
        onfocus: zmenaObjektu,
        oninput: (e) => zmenObjekt((x) => { x[klic] = Number(e.target.value) || 0; }),
      }));
    panelVybraneho.replaceChildren(
      h('div', { class: 'ed-vybrany-hlava' }, nahledObjektu(k, 40),
        h('span', { class: 'small' }, `${k.jmeno} · ${Math.round(k.s * m)} × ${Math.round(k.v * m)} px`)),
      h('div', { class: 'ed-otoceni-tlacitka' },
        h('button', { class: 'icon-btn', title: 'Zmenšit ([)', onclick: () => zmenMeritko(-1) }, '−'),
        h('span', { class: 'muted small ed-procenta' }, `${Math.round(m * 100)} %`),
        h('button', { class: 'icon-btn', title: 'Zvětšit (])', onclick: () => zmenMeritko(1) }, '+'),
        h('button', { class: 'icon-btn', title: 'Otočit doprava (O)', onclick: () => otocObjekt(1) }, '↻'),
        h('button', { class: 'icon-btn', title: 'Otočit doleva (Shift+O)', onclick: () => otocObjekt(-1) }, '↺'),
        h('button', {
          class: `icon-btn${(o.o || 0) >= 4 ? ' on' : ''}`, title: 'Překlopit zleva doprava (X)',
          onclick: preklopObjekt,
        }, '⇄'),
        h('button', { class: 'icon-btn', title: 'Udělat kopii (Ctrl+D)', onclick: duplikujVybrany }, '⧉'),
        h('button', { class: 'icon-btn', title: 'Smazat (Delete)', onclick: smazOznaceny }, '🗑')),
      h('label', { class: 'ed-sila', title: 'Velikost v procentech kresby' }, 'velikost',
        h('input', {
          type: 'range', min: '10', max: '400', step: '5', value: String(Math.round(m * 100)),
          onpointerdown: zmenaObjektu,      // jeden tah = jeden krok zpět
          oninput: (e) => {
            zmenObjekt((x) => { x.m = Number(e.target.value) / 100; });
            panelVybraneho.querySelector('.ed-procenta').textContent = `${e.target.value} %`;
          },
        })),
      h('div', { class: 'ed-poloha' }, cislo('x', 'x'), cislo('y', 'y'),
        h('span', { class: 'muted small' }, 'px od počátku')));
  }

  function kresliPaletuObjektu() {
    if (!S.objKatalog) return;
    const typy = [...new Set(S.objKatalog.polozky.map((k) => k.typ))];
    S.objTyp ??= typy[0];
    objZalozky.replaceChildren(...typy.map((t) => h('button', {
      class: t === S.objTyp ? 'on' : '', onclick: () => { S.objTyp = t; kresliPaletuObjektu(); },
    }, S.objKatalog.nazvyTypu?.[t] || t)));
    objMrizka.replaceChildren(...S.objKatalog.polozky.filter((k) => k.typ === S.objTyp).map((k) => {
      const b = h('button', {
        class: `ed-dlazdice${k === S.objVybrany ? ' on' : ''}`,
        title: `${k.jmeno} · ${k.s} × ${k.v} px${k.naMrizku ? ' · sedá na mřížku' : ''}`,
        onpointerdown: (e) => { e.preventDefault(); zacniZPalety(e, k); },
      });
      b.append(nahledObjektu(k));
      return b;
    }));
    objPopis.replaceChildren(S.objVybrany
      ? `${S.objVybrany.jmeno} · ${S.objVybrany.s} × ${S.objVybrany.v} px${S.objVybrany.naMrizku ? ' · sedá na mřížku' : ''}`
      : 'Vyber objekt a přetáhni ho na mapu');
  }

  // ---------- nabídka pod pravým tlačítkem ----------

  const nabidka = h('div', { class: 'ed-nabidka', hidden: true });

  function zavriNabidku() {
    if (!nabidka.hidden) nabidka.hidden = true;
  }

  function otevriNabidku(e, i) {
    S.objOznaceny = i;
    kresli();
    kresliVybrany();
    stav();
    const o = S.objekty[i];
    const k = objPodleJmena.get(o.j);
    const radek = (znak, popis, co) => h('button', {
      onclick: () => { zavriNabidku(); co(); },
    }, h('span', { class: 'ed-nabidka-znak' }, znak), popis);
    nabidka.replaceChildren(
      h('div', { class: 'ed-nabidka-hlava muted small' }, k?.jmeno || o.j),
      radek('⬆', 'Do popředí', doPopredi),
      radek('⬇', 'Do pozadí', doPozadi),
      radek('↕', 'Řadit podle paty', podlePaty),
      radek('↻', 'Otočit doprava', () => otocObjekt(1)),
      radek('⇄', 'Překlopit', preklopObjekt),
      radek('⧉', 'Udělat kopii', duplikujVybrany),
      radek('🗑', 'Smazat', smazOznaceny));
    nabidka.hidden = false;
    nabidka.style.left = `${Math.max(4, Math.min(e.clientX, innerWidth - nabidka.offsetWidth - 8))}px`;
    nabidka.style.top = `${Math.max(4, Math.min(e.clientY, innerHeight - nabidka.offsetHeight - 8))}px`;
  }

  addEventListener('pointerdown', (e) => {
    if (!nabidka.hidden && !nabidka.contains(e.target)) zavriNabidku();
  }, true);

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

  /** 8× nebo 2/3× — zlomek se píše jako zlomek, ať se to dá přečíst. */
  function popisZoomu(z) {
    if (z >= 1) return `${z}×`;
    for (const citatel of [1, 2, 3]) {
      const jmenovatel = citatel / z;
      if (Math.abs(jmenovatel - Math.round(jmenovatel)) < 1e-9) return `${citatel}/${Math.round(jmenovatel)}×`;
    }
    return `${Math.round(z * 100)} %`;
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
    const m = S.svet.meze();
    const v = S.katalog?.polozky.find((x) => x.i === S.vybrana);
    const rozsah = m
      ? `${m.sirka} × ${m.vyska} dlaždic (od ${m.x0},${m.y0} do ${m.x1},${m.y1}) · položeno ${S.svet.pocet()}`
      : 'zatím prázdný svět';
    stavovyRadek.replaceChildren(
      `${S.nazev} · ${rozsah} · zoom ${popisZoomu(S.zoom)} · štětec ${S.sila}`
      + `${v ? ` · ${v.jmeno}${S.otoceni ? ` ${popisOtoceni(S.otoceni)}` : ''}` : ''}`
      + `${S.objekty.length ? ` · objektů ${S.objekty.length}` : ''}`
      + `${S.kurzor ? ` · kurzor ${S.kurzor.x},${S.kurzor.y}` : ''}`);
  }

  // ---------- myš a klávesy ----------

  let kresliSe = false;
  let posouvaSe = null;
  let mezernik = false;
  let tazenyObjekt = null;      // { i, dx, dy, nove, pohnuto } — objekt tažený po mapě
  let pravyKlik = null;         // kde se stisklo pravé tlačítko (klik × posun mapy)

  /** Klik nástrojem Objekty: na objektu ho chytne, jinde položí vybraný z palety. */
  function zacniObjekt(e) {
    if (!S.objKatalog) { nactiObjekty(); return; }
    if (chytUchyt(e)) return;
    const bod = naSvet(e);
    let i = objektNa(bod);
    let nove = false;
    if (i < 0) {
      i = polozObjekt(bod, e.shiftKey);
      if (i < 0) { toast('Vyber nejdřív objekt v paletě vlevo'); return; }
      nove = true;
    }
    S.objOznaceny = i;
    const o = S.objekty[i];
    tazenyObjekt = { i, dx: o.x - bod.x, dy: o.y - bod.y, nove, pohnuto: false };
    kresli();
    kresliVybrany();
    stav();
  }

  /** Žlutý čtvereček v pravém horním rohu vybraného objektu: tahem se mění velikost. */
  function chytUchyt(e) {
    const o = S.objekty[S.objOznaceny];
    const k = o && objPodleJmena.get(o.j);
    if (!k) return false;
    const r = rozmerObjektu(k, o);
    const kam = platno.getBoundingClientRect();
    const hx = kam.left + S.posunX + (o.x + r.s / 2) * S.zoom;
    const hy = kam.top + S.posunY + (o.y - r.v) * S.zoom;
    if (Math.abs(e.clientX - hx) > UCHYT || Math.abs(e.clientY - hy) > UCHYT) return false;
    zmenaObjektu();
    tazenyObjekt = { i: S.objOznaceny, meritko: true, pohnuto: true, nove: false };
    return true;
  }

  function tahniObjekt(e) {
    const o = S.objekty[tazenyObjekt.i];
    if (!o) { tazenyObjekt = null; return; }
    if (tazenyObjekt.meritko) {
      const k = objPodleJmena.get(o.j);
      const zaklad = (o.o || 0) % 2 ? k.s : k.v;      // po čtvrtotáčce měří výšku původní šířka
      const nove = (o.y - naSvet(e).y) / Math.max(1, zaklad);
      o.m = Math.min(8, Math.max(0.1, Math.round(nove * 100) / 100));
      kresli();
      kresliVybrany();
      return;
    }
    if (!tazenyObjekt.pohnuto) {
      if (!tazenyObjekt.nove) zmenaObjektu();     // posun se dá vzít zpět, položení už zapsané je
      tazenyObjekt.pohnuto = true;
    }
    const bod = naSvet(e);
    const kam = pripni({ x: bod.x + tazenyObjekt.dx, y: bod.y + tazenyObjekt.dy },
      objPodleJmena.get(o.j), e.shiftKey);
    o.x = kam.x;
    o.y = kam.y;
    kresli();
  }

  platno.addEventListener('contextmenu', (e) => e.preventDefault());

  platno.addEventListener('pointerdown', (e) => {
    if (!S.atlas) return;
    try { platno.setPointerCapture(e.pointerId); } catch {}
    // Posun: pravé i prostřední tlačítko, mezerník nebo nástroj ruka. Táhne se kamkoli, svět nemá
    // okraje. Mazání zůstává na gumě (E), ať se posun a mazání nepletou.
    if (e.button === 2 || e.button === 1 || mezernik || S.nastroj === 'ruka') {
      // Pravým se posouvá mapa, ale když se jím jen klikne na objekt, otevře se nabídka.
      pravyKlik = e.button === 2 ? { x: e.clientX, y: e.clientY } : null;
      posouvaSe = { x: e.clientX - S.posunX, y: e.clientY - S.posunY };
      return;
    }
    if (S.nastroj === 'objekt') return zacniObjekt(e);
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
    if (tazenyObjekt) return tahniObjekt(e);
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
    if (tazenyObjekt) {
      tazenyObjekt = null;
      uloz();
      stav();
      return;
    }
    if (posouvaSe) {
      posouvaSe = null;
      const klik = pravyKlik && Math.abs(e.clientX - pravyKlik.x) < 5 && Math.abs(e.clientY - pravyKlik.y) < 5;
      pravyKlik = null;
      if (klik && S.objKatalog) {
        const i = objektNa(naSvet(e));
        if (i >= 0) otevriNabidku(e, i);
      }
      return;
    }
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
    // Když je vybraný objekt na mapě, otáčí se on; jinak dlaždice, co se zrovna pokládá.
    const naObjekt = S.objOznaceny >= 0;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); return duplikujVybrany(); }
    if (e.key.toLowerCase() === 'o') {
      e.preventDefault();
      return naObjekt ? otocObjekt(e.shiftKey ? -1 : 1) : otoc(e.shiftKey ? -1 : 1);
    }
    if (e.key.toLowerCase() === 'x') { e.preventDefault(); return naObjekt ? preklopObjekt() : preklop(); }
    if (e.key === '[' || e.key === ']') { e.preventDefault(); return zmenMeritko(e.key === ']' ? 1 : -1); }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); return smazOznaceny(); }
    if (e.key === 'Escape') { zavriNabidku(); S.objOznaceny = -1; kresliVybrany(); return kresli(); }
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
    for (const i of S.objAtlas ? poradiObjektu() : []) {
      const o = S.objekty[i];
      const k = objPodleJmena.get(o.j);
      if (!k) continue;
      const r = rozmerObjektu(k, o);
      kresliObjektDo(g, k, o, Math.round(o.x - m.x0 * 32 - r.s / 2), Math.round(o.y - m.y0 * 32 - r.v),
        Math.round(r.s), Math.round(r.v));
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
        S.objekty = nacteny.objekty || [];
        S.objOznaceny = -1;
        if (S.objekty.length) nactiObjekty();
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
    S.objekty = [];
    S.objOznaceny = -1;
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

  const panelObjektu = h('div', {}, objZalozky, objMrizka, objPopis,
    h('div', { class: 'ed-otoceni' }, panelVybraneho),
    h('p', { class: 'muted small' }, 'Přetáhni objekt z palety na mapu. Na mapě ho chytíš a posuneš, '
      + 'za žlutý čtvereček v rohu zvětšíš, Delete ho smaže. Se Shiftem sedne na mřížku.'));

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
    // Záložka rovnou přepne nástroj, ať se nestane, že člověk kreslí dlaždice místo objektů.
    if (co === 'objekty') {
      nactiObjekty();
      S.nastroj = 'objekt';
    } else if (S.nastroj === 'objekt') {
      S.nastroj = 'stetec';
    }
    kresliListu();
    stav();
  }

  const koren = h('main', { class: 'editor', id: 'editor', hidden: true }, nabidka,
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

  /** Atlas objektů má pár megabajtů, tak se stahuje, až je potřeba: při otevření záložky
   *  Objekty nebo když má načtený svět nějaké objekty položené. */
  async function nactiObjekty() {
    if (S.objKatalog || S.objNacitam) return;
    S.objNacitam = true;
    objPopis.replaceChildren('Stahuju objekty…');
    try {
      const [blob, json] = await Promise.all([
        repoImage(ATLAS_OBJ_PNG),
        gh(`${REPO}/contents/${encPath(ATLAS_OBJ_JSON)}?ref=${CFG.branch}`,
          { accept: 'application/vnd.github.raw', raw: true }).then((r) => r.json()),
      ]);
      S.objAtlas = await createImageBitmap(blob);
      S.objKatalog = json;
      objPodleJmena.clear();
      for (const k of json.polozky) objPodleJmena.set(k.soubor, k);
      kresliPaletuObjektu();
      kresliVybrany();
      kresli();
      stav();
    } catch (e) {
      objPopis.replaceChildren('Objekty se nenačetly');
      toast(`Objekty se nenačetly: ${e.message}`, true);
    } finally {
      S.objNacitam = false;
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
        if (ulozeny) {
          S.nazev = ulozeny.nazev;
          S.svet = ulozeny.svet;
          S.objekty = ulozeny.objekty || [];
          nahledy.clear();
          if (S.objekty.length) nactiObjekty();
        }
        kresliListu();
        stav();
      }
      prizpusob();
      if (!S.atlas) nactiAtlas().then(() => { nasted(); kresli(); });
      else kresli();
    },
    skryj() { zavriNabidku(); koren.hidden = true; },
  };
}
