// Boj a nepřátelé — záložka nástěnky na ladění balancu hry.
//
// Výchozí hodnoty a jejich popisy, rozsahy a obrázky vyrábí herní repo (tools/balanc-vychozi.ts →
// board/combat/vychozi.json). Nástěnka do hry zapisuje jen PŘEPISY: shared/balanc.json, plochá mapa
// klíč → hodnota, a jen hodnoty, které se liší od výchozích (rovná se výchozí = přepis zmizí). Hra
// soubor načte při startu serveru i klienta. Formát obou souborů je smlouva s herním repem, neměnit
// bez úpravy obou stran:
//   { verze:1, upraveno, autor, poznamka, prepisy:{klíč:hodnota}, vychoziPriUlozeni:{klíč:hodnota} }
//
// Hodnota klíče se čte vždy přes v(k) = rozpracovaná změna ?? uložený přepis ?? výchozí. Rozpracované
// změny (koncept) přežijí obnovení stránky v localStorage. Odvozené ukazatele (rány na zabití, XP za
// minutu…) se počítají stejnými vzorci jako ve hře, jednou z výchozích hodnot a jednou z upravených.

const BALANC = 'shared/balanc.json';
const VYCHOZI = 'board/combat/vychozi.json';
const ULOZISTE = 'mmo-nastenka-boj';
const ULOZISTE_KALK = 'mmo-nastenka-boj-kalk';
const UINT16 = 65535;
const ODSTIN = 1e-9;

const ZKRATKY_MIST = { vesnice: 'vesnice' };

function cti(klic) {
  try { return JSON.parse(localStorage.getItem(klic) || 'null'); } catch { return null; }
}
function zapis(klic, val) {
  try { val == null ? localStorage.removeItem(klic) : localStorage.setItem(klic, JSON.stringify(val)); } catch {}
}

function zBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function doBase64(text) {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

const cislo = (x, des = 2) => (Number.isFinite(x)
  ? x.toLocaleString('cs-CZ', { maximumFractionDigits: des }) : '–');
const stejne = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < ODSTIN : a === b);
const serad = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
/** „Životy na základní úrovni typu (roste …)" → „Životy na základní úrovni typu". Do zprávy commitu a rozdílu. */
const kratce = (popis) => popis.replace(/\s*\(.*$/, '');

export function vytvorBoj(api) {
  const { h, gh, repoImage, toast, encPath, CFG, me } = api;
  const REPO = `/repos/${CFG.owner}/${CFG.repo}`;
  const jmeno = (login) => CFG.team.find((m) => m.login === login)?.name || login || 'někdo';

  const S = {
    nacteno: false,
    nacitam: false,
    chyba: null,
    D: null,               // obsah vychozi.json
    H: new Map(),          // klíč → metadata hodnoty
    ulozeno: {},           // přepisy z balanc.json
    vpu: {},               // vychoziPriUlozeni z balanc.json
    autor: null,
    upraveno: null,
    zaklad: null,          // sha balanc.json (null = soubor není)
    koncept: {},           // rozpracované: klíč → hodnota, null = vrátit na výchozí / odebrat
    skupina: 'nepratele',
    hledat: '',
    jenUpravene: false,
  };
  const K = Object.assign({
    postava: 'valecnik', uroven: 1, zbran: '', rarita: 'bezna', urovenZbrane: null, obrana: 0, noc: false, hracu: 1, otevrena: true,
  }, cti(ULOZISTE_KALK) || {});

  // ---------- hodnoty ----------

  const meta = (k) => S.H.get(k);
  const vych = (k) => meta(k)?.vychozi;
  const ma = (k) => S.H.has(k);
  function v(k) {
    if (Object.hasOwn(S.koncept, k)) return S.koncept[k] === null ? vych(k) : S.koncept[k];
    if (Object.hasOwn(S.ulozeno, k)) return S.ulozeno[k];
    return vych(k);
  }
  /** Hodnota, kterou má klíč ve hře teď (uložený přepis, jinak výchozí). */
  const ulozenaHodnota = (k) => (Object.hasOwn(S.ulozeno, k) ? S.ulozeno[k] : vych(k));

  function nastav(k, val) {
    if (stejne(val, ulozenaHodnota(k))) delete S.koncept[k];
    else if (stejne(val, vych(k))) S.koncept[k] = null; // uložený přepis zpět na výchozí
    else S.koncept[k] = val;
    ulozKoncept();
    zmeneno();
  }
  function vratNaVychozi(k) {
    if (Object.hasOwn(S.ulozeno, k)) S.koncept[k] = null;
    else delete S.koncept[k];
    ulozKoncept();
    zmeneno();
  }
  const ulozKoncept = () => zapis(ULOZISTE, Object.keys(S.koncept).length ? { prepisy: S.koncept, zaklad: S.zaklad } : null);

  /** Přepisy, které by se teď uložily: jen hodnoty jiné než výchozí, plus zachované neznámé klíče. */
  function novePrepisy() {
    const o = {};
    for (const k of S.H.keys()) {
      const x = v(k);
      if (!stejne(x, vych(k))) o[k] = x;
    }
    for (const k of Object.keys(S.ulozeno)) if (!ma(k) && S.koncept[k] !== null) o[k] = S.ulozeno[k];
    return serad(o);
  }
  /** Rozdíl proti uloženému stavu: [{ k, stare, nove }], undefined = bez přepisu (výchozí). */
  function rozdil() {
    const nove = novePrepisy();
    const klice = [...new Set([...Object.keys(S.ulozeno), ...Object.keys(nove)])].sort();
    return klice.filter((k) => !stejne(S.ulozeno[k], nove[k])).map((k) => ({ k, stare: S.ulozeno[k], nove: nove[k] }));
  }

  // ---------- vzorce (stejné jako ve hře) ----------

  // g = čtečka hodnot: vych (výchozí stav) nebo v (upravený stav)
  const silaNep = (g, L, Lt) => Math.max(0.5, 1 + g('zony.silaZaUroven') * (L - Lt));
  const silaPredm = (g, u) => 1 + g('predmety.silaZaUroven') * (u - 1);
  const poObrane = (d, o) => Math.max(1, Math.round((d * 100) / (100 + Math.max(0, o))));
  const maxZivoty = (g, u, p) => g('hrac.zivoty') + g('hrac.zivotyZaUroven') * (Math.min(30, u) - 1) + (g(`postava.${p}.zivoty`) ?? 0);
  const smeckaPrumer = (g, t) => (ma(`nepritel.${t}.smecka.od`) ? (g(`nepritel.${t}.smecka.od`) + g(`nepritel.${t}.smecka.do`)) / 2 : 1);
  /** „bezna" → „běžná" (jméno rarity je jen v sekci jejích hodnot). */
  const nazevRarity = (r) => S.D.entity[`rarita.${r}`]?.nazev || r;
  const nazevTypu = (t) => S.D.entity[`nepritel.${t}`]?.nazev || t;
  const parseSkupiny = (s) => String(s || '').split('|').map((x) => x.split(',').map((t) => t.trim()).filter(Boolean)).filter((x) => x.length);

  function zbranKalk() {
    const p = S.D.entity[`postava.${K.postava}`]?.info;
    if (K.zbran && S.D.entity[K.zbran]) return K.zbran;
    return p?.start?.zbran ? `zbran.${p.start.zbran}` : Object.keys(S.D.entity).find((e) => e.startsWith('zbran.'));
  }
  /** Rána hráče z kalkulačky (holá výbava: bez stromu dovedností a vlastností předmětů). */
  function ranaHrace(g, postava = K.postava, zbran = zbranKalk()) {
    if (!zbran || !ma(`${zbran}.poskozeni`)) return null;
    const luk = zbran.startsWith('luk.');
    const UZ = K.urovenZbrane ?? K.uroven;
    let nasobek = 1;
    let rozsah = null;
    const vl = (x) => g(`vlastnost.${postava}.${x}`);
    if (postava === 'krysar' && ma('vlastnost.krysar.utok')) nasobek = vl('utok');
    if (postava === 'mag') nasobek = luk ? vl('kouzlo') ?? 1 : vl('nablizko') ?? 1;
    if (postava === 'sasek' && ma('vlastnost.sasek.bezMasky')) nasobek = vl('bezMasky');
    if (postava === 'lovec_carodejnic' && !luk && ma('vlastnost.lovec_carodejnic.seky')) nasobek = vl('seky');
    if (postava === 'lovec' && luk && ma('vlastnost.lovec.blizko')) rozsah = [vl('blizko'), vl('daleko')];
    const zaklad = g(`${zbran}.poskozeni`) * (g(`rarita.${K.rarita}.nasobek`) ?? 1) * silaPredm(g, UZ);
    const rana = Math.max(1, Math.round(zaklad * nasobek));
    return {
      rana, prodleva: g(`${zbran}.prodlevaMs`),
      rozsah: rozsah && rozsah.map((x) => Math.max(1, Math.round(zaklad * x))),
    };
  }

  function ranaDoHrace(g, t, L, { noc = K.noc, tlak = 1 } = {}) {
    const e = `nepritel.${t}`;
    const s = S.D.data?.nepratele?.[t]?.strelba ?? S.D.entity[e]?.info?.strelba;
    const zakl = s && ma(`strela.${s}.poskozeni`) ? g(`strela.${s}.poskozeni`) : g(`${e}.poskozeni`);
    if (!zakl) return 0;
    let r = Math.round(zakl * silaNep(g, L, g(`${e}.uroven`)) * (noc ? g('noc.poskozeni') : 1));
    r = poObrane(r, K.obrana);
    if (K.postava === 'valecnik' && ma('vlastnost.valecnik.tvrdaKuze')) r = Math.max(1, r - g('vlastnost.valecnik.tvrdaKuze'));
    if (K.postava === 'lovec_carodejnic' && ma('vlastnost.lovec_carodejnic.kniha')) r = Math.round(r * g('vlastnost.lovec_carodejnic.kniha'));
    return Math.max(1, Math.round(r * tlak));
  }

  /** Boj jeden na jednoho s nepřítelem `t` na úrovni L (HP = životy nepřítele). */
  function souboj(g, t, L, HP, opt = {}) {
    const e = `nepritel.${t}`;
    const r = ranaHrace(g);
    const ven = opt.ven ?? 1;
    const rana = r ? Math.max(1, Math.round(r.rana * ven)) : null;
    const rany = rana ? Math.ceil(HP / rana) : null;
    const cas = rany ? ((rany - 1) * r.prodleva) / 1000 : null;
    const doHrace = ranaDoHrace(g, t, L, opt);
    const cyklus = (g(`${e}.naprahMs`) + g(`${e}.prodlevaMs`)) / 1000;
    const hp = maxZivoty(g, K.uroven, K.postava);
    return {
      HP, rany, cas, doHrace, cyklus,
      dps: doHrace ? doHrace / cyklus : 0,
      zabijeZa: doHrace ? Math.ceil(hp / doHrace) * cyklus : Infinity,
    };
  }

  const hpVeSvete = (g, t, L) => Math.round(g(`nepritel.${t}.zivoty`) * silaNep(g, L, g(`nepritel.${t}.uroven`)));
  function hpVDungeonu(g, d, t, n) {
    const zaHrace = g(`dungeon.${d}.zivotyZaHrace.${t}`) ?? 0;
    const z = Math.min(65000, Math.round(g(`nepritel.${t}.zivoty`) * (1 + zaHrace * (n - 1))));
    return Math.round(z * silaNep(g, g(`dungeon.${d}.sila`), g(`nepritel.${t}.uroven`)));
  }
  const prumerZony = (g, z) => (g(`${z}.uroven_od`) + Math.max(g(`${z}.uroven_od`), g(`${z}.uroven_do`))) / 2;

  /** Kde nepřítel žije a na jaké úrovni: [{ id, nazev, L, dungeon? }] */
  function mistaNepritele(g, t) {
    const kde = S.D.entity[`nepritel.${t}`]?.info?.kde || [];
    const out = [];
    for (const m of kde) {
      if (m.startsWith('zona.') && S.D.entity[m]) out.push({ id: m, nazev: S.D.entity[m].nazev, L: prumerZony(g, m) });
      else if (m.startsWith('dungeon.') && S.D.entity[m]) out.push({ id: m, nazev: S.D.entity[m].nazev, L: g(`${m}.sila`), dungeon: m.slice(8) });
      else if (m === 'vesnice' && ma('vesnice.utocnici.od')) out.push({ id: m, nazev: 'Útok na vesnici', L: (g('vesnice.utocnici.od') + g('vesnice.utocnici.do')) / 2 });
    }
    if (!out.length) out.push({ id: 'zaklad', nazev: 'Na základní úrovni', L: g(`nepritel.${t}.uroven`) });
    return out;
  }

  // ---------- obrázky ----------

  const bitmapy = new Map();
  function bitmapa(cesta) {
    if (!bitmapy.has(cesta)) {
      bitmapy.set(cesta, repoImage(cesta).then((b) => createImageBitmap(b)).catch((e) => { bitmapy.delete(cesta); throw e; }));
    }
    return bitmapy.get(cesta);
  }
  /**
   * Výřez snímku `obr` do canvasu. `cil` px je přibližná velikost: snímek se zvětší celým násobkem
   * (nebo zmenší celým dělitelem), ať pixel art zůstane ostrý.
   */
  function obrazek(obr, cil = 112, barva = null) {
    const c = h('canvas', { class: 'boj-obr', width: 1, height: 1 });
    if (!obr?.cesta) { c.hidden = true; return c; }
    const n = obr.snimek || 32;
    const mer = n <= cil ? Math.max(1, Math.round(cil / n)) : 1 / Math.max(1, Math.round(n / cil));
    const vel = Math.round(n * mer);
    c.width = vel; c.height = vel;
    c.style.width = c.style.height = `${vel}px`;
    bitmapa(obr.cesta).then((b) => {
      const x = c.getContext('2d');
      x.imageSmoothingEnabled = false;
      x.drawImage(b, (obr.sloupec || 0) * n, (obr.rada || 0) * n, n, n, 0, 0, vel, vel);
      if (barva) {
        // zástupná postava je bílá, hra ji obarví barvou postavy
        x.globalCompositeOperation = 'multiply';
        x.fillStyle = barva;
        x.fillRect(0, 0, vel, vel);
        x.globalCompositeOperation = 'destination-in';
        x.drawImage(b, (obr.sloupec || 0) * n, (obr.rada || 0) * n, n, n, 0, 0, vel, vel);
      }
    }).catch(() => c.classList.add('chybi'));
    return c;
  }
  function obrazekEntity(id, cil, L) {
    const e = S.D.entity[id];
    if (!e?.obrazek) return null;
    let obr = e.obrazek;
    if (L != null && e.varianty?.length) {
      const vr = [...e.varianty].filter((x) => x.od <= L).pop();
      if (vr) obr = { ...obr, cesta: vr.cesta };
    }
    return obrazek(obr, cil, e.obrazek.cesta.endsWith('zastupna.png') ? e.info?.barva : null);
  }
  const ikonaTypu = (t) => obrazekEntity(`nepritel.${t}`, 32) || h('span', {}, '');

  // ---------- kostra ----------

  const skupinyEl = h('div', { class: 'boj-skupiny', role: 'tablist' });
  const hledatEl = h('input', { type: 'search', placeholder: 'Hledat (skřet, životy, nepritel.vlk…)', 'aria-label': 'Hledat' });
  const jenEl = h('input', { type: 'checkbox' });
  const pocitadlo = h('span', { class: 'boj-pocet muted small' });
  const btnRozdil = h('button', { class: 'btn', onclick: () => otevriRozdil(false) }, 'Rozdíl');
  const btnZahodit = h('button', { class: 'btn', onclick: zahodit }, 'Zahodit změny');
  const btnUlozit = h('button', { class: 'btn primary', onclick: () => otevriRozdil(true) }, 'Uložit do hry');
  const stavEl = h('p', { class: 'boj-stav muted small' });
  const kalkEl = h('details', { class: 'boj-kalk' });
  const obsah = h('div', { class: 'boj-obsah' });
  const dlg = h('dialog', { class: 'dlg boj-dlg' });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

  hledatEl.addEventListener('input', () => { S.hledat = hledatEl.value.trim().toLowerCase(); vykresli(); });
  jenEl.addEventListener('change', () => { S.jenUpravene = jenEl.checked; vykresli(); });
  kalkEl.addEventListener('toggle', () => { K.otevrena = kalkEl.open; zapis(ULOZISTE_KALK, K); });

  const koren = h('section', { class: 'boj', hidden: true },
    h('div', { class: 'boj-lista' },
      skupinyEl,
      h('div', { class: 'boj-hledat' }, hledatEl,
        h('label', { class: 'boj-jen small' }, jenEl, 'jen upravené')),
      h('div', { class: 'boj-akce' }, pocitadlo, btnRozdil, btnZahodit, btnUlozit)),
    stavEl,
    kalkEl,
    obsah,
    dlg);

  // ---------- načtení ----------

  async function nacti() {
    S.nacitam = true;
    S.chyba = null;
    vykresli();
    try {
      let D;
      try {
        const r = await gh(`${REPO}/contents/${encPath(VYCHOZI)}?ref=${CFG.branch}`, { accept: 'application/vnd.github.raw', raw: true });
        D = JSON.parse(await r.text());
      } catch (e) {
        if (e.status === 404) throw new Error('Výchozí hodnoty ještě nejsou vygenerované (tools/balanc-vychozi.ts v herním repu).');
        throw e;
      }
      if (D?.verze !== 1 || !Array.isArray(D.hodnoty)) throw new Error(`${VYCHOZI} má neznámý formát (verze ${D?.verze}).`);
      S.D = D;
      S.H = new Map(D.hodnoty.map((x) => [x.klic, x]));
      await nactiBalanc();
      const k = cti(ULOZISTE);
      if (k?.prepisy && typeof k.prepisy === 'object') {
        S.koncept = k.prepisy;
        for (const kl of Object.keys(S.koncept)) if (S.koncept[kl] !== null && stejne(S.koncept[kl], ulozenaHodnota(kl))) delete S.koncept[kl];
        if (k.zaklad !== S.zaklad && Object.keys(S.koncept).length) toast('Rozpracované změny jsou zpátky. Balanc ve hře se mezitím změnil, zkontroluj Rozdíl.');
      }
      if (!S.D.skupiny.some((s) => s.id === S.skupina)) S.skupina = S.D.skupiny[0]?.id;
      if (!S.D.data?.postavy?.includes(K.postava)) K.postava = S.D.data?.postavy?.[0];
      S.nacteno = true;
    } catch (e) {
      S.chyba = e.message;
    } finally {
      S.nacitam = false;
      vykresli();
    }
  }

  async function nactiBalanc() {
    let o = null;
    try {
      o = await gh(`${REPO}/contents/${encPath(BALANC)}?ref=${CFG.branch}`);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    S.zaklad = o?.sha || null;
    S.ulozeno = {}; S.vpu = {}; S.autor = null; S.upraveno = null; S.poznamka = '';
    if (!o) return;
    let b;
    try { b = JSON.parse(zBase64(o.content)); } catch { throw new Error(`${BALANC} v repu není platný JSON. Oprav ho ručně, hra ho teď ignoruje.`); }
    if (b?.verze !== 1) throw new Error(`${BALANC} má verzi ${b?.verze}, tahle nástěnka umí jen 1.`);
    S.ulozeno = b.prepisy && typeof b.prepisy === 'object' ? b.prepisy : {};
    S.vpu = b.vychoziPriUlozeni || {};
    S.autor = b.autor || null;
    S.upraveno = b.upraveno || null;
    S.poznamka = b.poznamka || '';
  }

  // ---------- vykreslení ----------

  let karty = [];   // { el, obnov() } pro živé přepočítání odvozených
  let radky = [];   // { k, obnov() }

  function zmeneno() {
    for (const r of radky) r.obnov();
    for (const k of karty) k.obnov?.();
    obnovListu();
  }

  function obnovListu() {
    const n = S.nacteno ? rozdil().length : 0;
    pocitadlo.textContent = n === 1 ? '1 změna' : n >= 2 && n <= 4 ? `${n} změny` : `${n} změn`;
    pocitadlo.classList.toggle('ma', n > 0);
    btnRozdil.disabled = btnZahodit.disabled = btnUlozit.disabled = !n;
    if (!S.nacteno) return;
    vykresliSkupiny();
    const pocet = Object.keys(S.ulozeno).length;
    stavEl.replaceChildren(
      pocet ? `Ve hře (main) je ${pocet} ${pocet === 1 ? 'přepis' : pocet < 5 ? 'přepisy' : 'přepisů'}` : 'Ve hře (main) jsou všechny hodnoty výchozí',
      S.autor ? ` · naposled ${jmeno(S.autor)}${S.upraveno ? `, ${new Date(S.upraveno).toLocaleString('cs-CZ')}` : ''}` : '',
      S.poznamka ? ` · „${S.poznamka}"` : '',
      ` · výchozí hodnoty z ${S.D.commit || '?'}. Veřejný server se změní až po nasazení („nasaď na server“).`);
  }

  function vykresliSkupiny() {
    const sk = S.D?.skupiny || [];
    skupinyEl.replaceChildren(...sk.map((s) => {
      const n = rozdil().filter((d) => meta(d.k)?.skupina === s.id).length;
      return h('button', {
        class: s.id === S.skupina ? 'on' : null, role: 'tab',
        onclick: () => { S.skupina = s.id; vykresli(); obsah.scrollTop = 0; },
      }, s.nazev, n ? h('span', { class: 'boj-tecka', title: `${n} změn` }, String(n)) : null);
    }));
  }

  function vykresli() {
    karty = [];
    radky = [];
    if (!S.nacteno) {
      skupinyEl.replaceChildren();
      kalkEl.replaceChildren();
      obsah.replaceChildren(h('p', { class: S.chyba ? 'empty err' : 'empty' },
        S.chyba || (S.nacitam ? 'Načítám výchozí hodnoty a balanc z repa…' : '')),
      S.chyba ? h('p', { class: 'empty' }, h('button', { class: 'btn', onclick: nacti }, 'Zkusit znovu')) : null);
      obnovListu();
      return;
    }
    vykresliKalk();
    const sk = S.skupina;
    const ent = S.D.entity;
    const entity = [];
    const vSkupine = new Map();
    for (const x of S.D.hodnoty) {
      if (x.skupina !== sk) continue;
      if (!vSkupine.has(x.entita)) { vSkupine.set(x.entita, []); entity.push(x.entita); }
      vSkupine.get(x.entita).push(x);
    }
    const q = S.hledat;
    const projde = (x) => {
      if (S.jenUpravene && stejne(v(x.klic), vych(x.klic)) && !Object.hasOwn(S.koncept, x.klic)) return false;
      if (!q) return true;
      const en = ent[x.entita]?.nazev || '';
      return [x.popis, x.klic, en, x.sekce].some((s) => String(s || '').toLowerCase().includes(q));
    };

    const vystup = [];
    const nezname = Object.keys(S.ulozeno).filter((k) => !ma(k));
    if (nezname.length) vystup.push(kartaNeznamych(nezname));

    const tabulky = { zbran: [], luk: [], aktivni: [], rarita: [] };
    for (const id of entity) {
      const hodnoty = vSkupine.get(id).filter(projde);
      if (!hodnoty.length) continue;
      const pref = id.split('.')[0];
      if (tabulky[pref]) { tabulky[pref].push([id, hodnoty]); continue; }
      vystup.push(karta(id, hodnoty));
    }
    if (tabulky.zbran.length) vystup.push(kartaTabulky('Zbraně na blízko', tabulky.zbran, true));
    if (tabulky.luk.length) vystup.push(kartaTabulky('Luky, hole a vaky', tabulky.luk, true));
    if (tabulky.aktivni.length) vystup.push(kartaTabulky('Kouzla (aktivní schopnosti)', tabulky.aktivni, false));
    if (tabulky.rarita.length) vystup.push(kartaTabulky('Rarity předmětů', tabulky.rarita, false));
    if (!vystup.length) vystup.push(h('p', { class: 'empty' }, S.jenUpravene ? 'V téhle skupině nic upraveného není.' : 'Nic neodpovídá hledání.'));
    obsah.replaceChildren(...vystup);
    obnovListu();
  }

  // ---------- kalkulačka ----------

  function vykresliKalk() {
    const d = S.D.data || {};
    const sel = (moznosti, hodnota, zmen) => {
      const s = h('select', {}, ...moznosti.map(([val, txt]) => h('option', { value: val, selected: String(val) === String(hodnota) || null }, txt)));
      s.addEventListener('change', () => { zmen(s.value); zapis(ULOZISTE_KALK, K); vykresli(); });
      return s;
    };
    const num = (hodnota, min, max, zmen, ph) => {
      const i = h('input', { type: 'number', min, max, step: 1, value: hodnota ?? '', placeholder: ph || '' });
      i.addEventListener('change', () => { zmen(i.value === '' ? null : Math.max(min, Math.min(max, Math.round(+i.value)))); zapis(ULOZISTE_KALK, K); vykresli(); });
      return i;
    };
    const post = S.D.entity[`postava.${K.postava}`]?.info || {};
    const zbrane = [...(post.zbrane || []).map((z) => `zbran.${z}`), ...(post.nadalku || []).map((z) => `luk.${z}`)].filter((z) => S.D.entity[z]);
    if (K.zbran && !zbrane.includes(K.zbran)) K.zbran = '';
    const pole = (txt, el) => h('label', { class: 'boj-pole' }, h('span', {}, txt), el);
    const r = ranaHrace(v);
    kalkEl.open = K.otevrena;
    kalkEl.replaceChildren(
      h('summary', {}, h('b', {}, 'Kalkulačka'), h('span', { class: 'muted small' },
        ` ${S.D.entity[`postava.${K.postava}`]?.nazev || K.postava}, ${K.uroven}. úroveň, ${S.D.entity[zbranKalk()]?.nazev || '?'}`
        + (r ? ` (rána ${r.rana} za ${cislo(r.prodleva / 1000)} s)` : '') + (K.noc ? ', noc' : ''))),
      h('div', { class: 'boj-kalk-pole' },
        pole('Postava', sel((d.postavy || []).map((p) => [p, S.D.entity[`postava.${p}`]?.nazev || p]), K.postava, (x) => { K.postava = x; K.zbran = ''; })),
        pole('Úroveň hráče', num(K.uroven, 1, d.konstanty?.UROVEN_MAX || 30, (x) => { K.uroven = x ?? 1; })),
        pole('Zbraň', sel(zbrane.map((z) => [z, S.D.entity[z].nazev + (z === zbranKalk() && !K.zbran ? ' (startovní)' : '')]), zbranKalk(), (x) => { K.zbran = x; })),
        pole('Rarita zbraně', sel((d.rarity || ['bezna']).map((x) => [x, nazevRarity(x)]), K.rarita, (x) => { K.rarita = x; })),
        pole('Úroveň zbraně', num(K.urovenZbrane, 1, 30, (x) => { K.urovenZbrane = x; }, `= ${K.uroven}`)),
        pole('Obrana', num(K.obrana, 0, 1000, (x) => { K.obrana = x ?? 0; })),
        pole('Hráčů v dungeonu', sel([1, 2, 3, 4, 5].map((n) => [n, n]), K.hracu, (x) => { K.hracu = +x; })),
        h('label', { class: 'boj-pole boj-noc' }, (() => {
          const c = h('input', { type: 'checkbox', checked: K.noc || null });
          c.addEventListener('change', () => { K.noc = c.checked; zapis(ULOZISTE_KALK, K); vykresli(); });
          return c;
        })(), 'Noc')),
      h('p', { class: 'muted small boj-pozn' }, 'Odvozené ukazatele počítají s holou výbavou: bez stromu dovedností a vlastností předmětů, hráč neuhýbá.'));
  }

  // ---------- řádek hodnoty ----------

  function radek(x, { bezVstupu = false } = {}) {
    const k = x.klic;
    const cisl = x.typ !== 'text';
    const el = h('div', { class: 'boj-radek' });
    const vstup = cisl
      ? h('input', { type: 'number', min: x.min, max: x.max, step: x.krok ?? 'any', 'aria-label': x.popis })
      : h('input', { type: 'text', 'aria-label': x.popis });
    const posuv = cisl && Number.isFinite(x.min) && Number.isFinite(x.max)
      ? h('input', { type: 'range', min: x.min, max: x.max, step: x.krok ?? 'any', tabindex: -1, 'aria-hidden': 'true' }) : null;
    const vychEl = h('span', { class: 'boj-vych' });
    const delta = h('span', { class: 'boj-delta' });
    const reset = h('button', { class: 'boj-reset', title: 'Zpět na výchozí', onclick: () => vratNaVychozi(k) }, '↺');
    const varov = h('div', { class: 'boj-varov' });
    const precti = (raw) => {
      if (!cisl) return raw;
      if (raw === '' || !Number.isFinite(+raw)) return undefined;
      return +raw;
    };
    vstup.addEventListener('input', () => { const val = precti(vstup.value); if (val !== undefined) nastav(k, val); });
    vstup.addEventListener('blur', () => obnov(true));
    posuv?.addEventListener('input', () => nastav(k, +posuv.value));

    function obnov(i = false) {
      const val = v(k);
      const def = vych(k);
      if (i || document.activeElement !== vstup) vstup.value = val;
      if (posuv) posuv.value = val;
      const zmena = !stejne(val, def);
      const rozpr = Object.hasOwn(S.koncept, k);
      el.classList.toggle('zmena', zmena);
      el.classList.toggle('rozpr', rozpr);
      vychEl.textContent = cisl ? `výchozí ${cislo(def, 4)}` : '';
      vychEl.title = cisl ? '' : `výchozí: ${def}`;
      delta.textContent = zmena && cisl ? (def ? `${val > def ? '+' : '−'}${cislo(Math.abs(((val - def) / def) * 100), 1)} %` : 'nové') : zmena ? 'upraveno' : '';
      delta.classList.toggle('plus', cisl && val > def);
      reset.hidden = !zmena && !rozpr;
      const varovani = [];
      if (cisl) {
        if (val < x.min || val > x.max) varovani.push(`mimo rozsah ${cislo(x.min, 4)}–${cislo(x.max, 4)}, hra ho ořízne na ${cislo(Math.min(x.max, Math.max(x.min, val)), 4)}`);
        else if (x.krok >= 1 && !Number.isInteger(val)) varovani.push(`hra zaokrouhlí na ${Math.round(val)}`);
        const par = k.endsWith('.do') ? k.slice(0, -3) + '.od' : k.endsWith('_do') ? k.slice(0, -3) + '_od' : null;
        if (par && ma(par) && val < v(par)) varovani.push(`menší než „od“ (${cislo(v(par))}), hra nastaví stejně jako od`);
      } else if (k.endsWith('.skupiny')) {
        varovani.push(...chybySkupin(val));
      }
      if (Object.hasOwn(S.ulozeno, k) && Object.hasOwn(S.vpu, k) && !stejne(S.vpu[k], def)) {
        varovani.push(`výchozí se změnil (${S.vpu[k]} → ${def}) od uložení přepisu`);
      }
      el.classList.toggle('spatne', varovani.some((t) => t.startsWith('mimo') || t.startsWith('neznám') || t.startsWith('prázd') || t.startsWith('víc')));
      varov.replaceChildren(...varovani.map((t) => h('span', {}, t)));
      varov.hidden = !varovani.length;
    }
    radky.push({ k, obnov });
    obnov(true);
    if (bezVstupu) { vstup.hidden = true; vychEl.hidden = true; }
    el.append(
      h('div', { class: 'boj-popis', title: `${k}${x.pozn ? `\n⚠ ${x.pozn}` : ''}` }, x.popis, x.pozn ? h('span', { class: 'boj-pozor', title: x.pozn }, ' ⚠') : null),
      h('div', { class: 'boj-vstup' }, posuv, vstup, h('span', { class: 'boj-jedn' }, x.jednotka || '')),
      h('div', { class: 'boj-meta' }, vychEl, delta, reset),
      varov);
    return el;
  }

  function chybySkupin(s) {
    const varianty = parseSkupiny(s);
    const out = [];
    if (!varianty.length) out.push('prázdné: aspoň jedna varianta, jinak hra změnu ignoruje');
    const typy = S.D.data?.nepratele ? Object.keys(S.D.data.nepratele) : null;
    for (const v1 of varianty) {
      if (v1.length > 8) out.push(`víc než 8 nepřátel ve variantě (${v1.length}), hra změnu ignoruje`);
      for (const t of v1) if (typy && !typy.includes(t)) out.push(`neznámý typ „${t}“, hra změnu ignoruje`);
    }
    return [...new Set(out)];
  }

  /** Editor složení skupinek zóny: varianta na řádek, typy oddělené čárkou, s ikonkami. */
  function editorSkupin(x) {
    const k = x.klic;
    const el = h('div', { class: 'boj-skupinky' });
    const seznam = h('div', { class: 'boj-varianty' });
    const zapisVarianty = (varianty) => nastav(k, varianty.map((a) => a.join(',')).join('|'));
    function obnov(nutne = false) {
      if (!nutne && el.contains(document.activeElement)) return;
      const varianty = parseSkupiny(v(k));
      seznam.replaceChildren(...varianty.map((var1, i) => {
        const vstup = h('input', { type: 'text', value: var1.join(','), 'aria-label': `Varianta ${i + 1}` });
        const ikony = h('span', { class: 'boj-ikony' }, ...var1.map((t) => h('span', { title: nazevTypu(t) }, ikonaTypu(t))));
        vstup.addEventListener('change', () => {
          const nove = parseSkupiny(v(k));
          const typy = vstup.value.split(',').map((t) => t.trim()).filter(Boolean);
          if (typy.length) nove[i] = typy; else nove.splice(i, 1);
          zapisVarianty(nove);
          obnov(true);
        });
        return h('div', { class: 'boj-varianta' }, h('span', { class: 'muted small' }, `${i + 1}.`), vstup, ikony,
          h('button', { class: 'boj-reset', title: 'Odebrat variantu', onclick: () => { const nove = parseSkupiny(v(k)); nove.splice(i, 1); zapisVarianty(nove); obnov(true); } }, '✕'));
      }));
    }
    const typy = Object.keys(S.D.data?.nepratele || {});
    const pridat = h('select', { 'aria-label': 'Přidat variantu' },
      h('option', { value: '' }, '+ varianta…'), ...typy.map((t) => h('option', { value: t }, nazevTypu(t))));
    pridat.addEventListener('change', () => {
      if (!pridat.value) return;
      zapisVarianty([...parseSkupiny(v(k)), [pridat.value]]);
      pridat.value = '';
      obnov(true);
    });
    karty.push({ obnov: () => obnov() });
    obnov(true);
    el.append(seznam, h('div', { class: 'row' }, pridat, h('span', { class: 'muted small' }, 'Losuje se jedna varianta pro každý tábor, jednou při startu serveru.')));
    return el;
  }

  // ---------- karty ----------

  function kartaNeznamych(klice) {
    return h('article', { class: 'boj-karta boj-nezname' },
      h('header', {}, h('div', {}, h('h3', {}, 'Neznámé klíče'),
        h('p', { class: 'muted small' }, 'Jsou v shared/balanc.json, ale výchozí hodnoty je neznají (přejmenované nebo smazané v kódu). Hra je ignoruje. Při uložení zůstanou, dokud je neodebereš.'))),
      ...klice.map((k) => {
        const pryc = S.koncept[k] === null;
        return h('div', { class: `boj-radek${pryc ? ' odebrano' : ''}` },
          h('div', { class: 'boj-popis' }, h('code', {}, k)),
          h('div', { class: 'boj-vstup' }, h('span', {}, JSON.stringify(S.ulozeno[k]))),
          h('div', { class: 'boj-meta' }, h('button', {
            class: 'btn',
            onclick: () => { if (pryc) delete S.koncept[k]; else S.koncept[k] = null; ulozKoncept(); vykresli(); },
          }, pryc ? 'Vrátit' : 'Odebrat')));
      }));
  }

  function chipsInfo(id) {
    const e = S.D.entity[id];
    const i = e.info || {};
    const c = [];
    if (id.startsWith('nepritel.')) {
      const t = id.slice(9);
      const dn = S.D.data?.nepratele?.[t] || {};
      if (i.boss || dn.boss) c.push(['boss', 'boss']);
      const st = i.strelba ?? dn.strelba;
      if (st) c.push([`střílí: ${meta(`strela.${st}.poskozeni`)?.sekce?.replace(/^Střela:\s*/, '') || st}`]);
      if (i.smecka || dn.smecka) c.push(['ve smečce']);
      if (dn.volani) c.push([`přivolává: ${nazevTypu(dn.volani)}`]);
      if (dn.tlakHlubin) c.push(['tlak hlubin']);
      const kde = (i.kde || []).map((m) => S.D.entity[m]?.nazev || ZKRATKY_MIST[m] || m);
      if (kde.length) c.push([`ve: ${kde.join(', ')}`]);
    }
    if (id.startsWith('zona.')) {
      c.push([`${i.volneTabory ?? '?'} volných táborů`]);
      if (i.doupata?.length) c.push([`doupata: ${i.doupata.map((d) => d.skupina.map(nazevTypu).join('+')).join(', ')}`]);
    }
    if (id.startsWith('postava.')) {
      if (i.start?.zbran) c.push([`začíná: ${S.D.entity[`zbran.${i.start.zbran}`]?.nazev || i.start.zbran}`]);
      if (i.schopnost) c.push([`schopnost: ${i.schopnost}`]);
    }
    if (id.startsWith('dungeon.') && i.doporuceno) c.push([i.doporuceno]);
    return c.map(([t, cl]) => h('span', { class: `boj-chip${cl ? ` ${cl}` : ''}` }, t));
  }

  function karta(id, hodnoty) {
    const e = S.D.entity[id] || { nazev: id };
    const sekce = new Map();
    for (const x of hodnoty) {
      if (!sekce.has(x.sekce)) sekce.set(x.sekce, []);
      sekce.get(x.sekce).push(x);
    }
    const stav = { misto: null };
    const obrBox = h('div', { class: 'boj-obr-box' });
    const nastavObr = () => {
      const L = stav.misto ? mistaNepritele(v, id.slice(9)).find((m) => m.id === stav.misto)?.L : null;
      const o = obrazekEntity(id, 112, L);
      obrBox.replaceChildren(...(o ? [o] : []));
      obrBox.hidden = !o;
    };
    nastavObr();
    const telo = [];
    // Etapy dungeonu (sekce „Etapa 1: Vlna 1/3", „Etapa 2: …") jako jedna tabulka nahoře.
    const jeEtapa = (nazev) => nazev === 'Etapy' || /^Etapa \d+/.test(nazev);
    const etapove = id.startsWith('dungeon.') && S.D.data?.dungeony?.[id.slice(8)]
      ? [...sekce].filter(([nazev]) => jeEtapa(nazev)).flatMap(([, xs]) => xs) : [];
    if (etapove.length) telo.push(sekceEtap(id.slice(8), etapove));
    for (const [nazev, xs] of sekce) {
      if (etapove.length && jeEtapa(nazev)) continue;
      const rows = xs.map((x) => (x.typ === 'text' && x.klic.endsWith('.skupiny')
        ? [radek(x, { bezVstupu: true }), editorSkupin(x)]
        : [radek(x)]));
      // fáze bossů mají desítky čísel: zavřené, dokud v nich není změna nebo hledání
      const upraveno = xs.some((x) => !stejne(v(x.klic), x.vychozi) || Object.hasOwn(S.koncept, x.klic));
      const otevrit = !nazev.startsWith('Fáze') || upraveno || !!S.hledat || S.jenUpravene;
      telo.push(h('details', { class: 'boj-sekce', open: otevrit || null },
        h('summary', {}, h('h4', {}, nazev, h('span', { class: 'muted small' }, ` ${xs.length}`))), ...rows.flat(), soucty(xs)));
    }
    const odv = h('div', { class: 'boj-odvozene' });
    const obnovOdv = () => {
      const blok = odvozene(id, stav, () => { nastavObr(); obnovOdv(); });
      odv.replaceChildren(...(blok ? [blok] : []));
      odv.hidden = !blok;
    };
    karty.push({ obnov: obnovOdv });
    obnovOdv();
    return h('article', { class: 'boj-karta', 'data-entita': id },
      h('header', {}, obrBox, h('div', {},
        h('h3', {}, e.nazev),
        h('div', { class: 'boj-chips' }, ...chipsInfo(id)))),
      ...telo,
      odv);
  }

  /** Řádek se součtem u hodnot, které mají dát dohromady 100 (rarity). */
  function soucty(xs) {
    const skup = [...new Set(xs.filter((x) => x.soucet).map((x) => x.soucet))];
    if (!skup.length) return null;
    const el = h('div', { class: 'boj-soucet small' });
    const obnov = () => {
      el.replaceChildren(...skup.map((s) => {
        const sum = S.D.hodnoty.filter((x) => x.soucet === s).reduce((a, x) => a + v(x.klic), 0);
        const ok = Math.abs(sum - 100) < 0.01;
        return h('div', { class: ok ? 'muted' : 'err' }, `Dohromady ${cislo(sum)} %${ok ? '' : ', hra přenormuje na 100'}`);
      }));
    };
    karty.push({ obnov });
    obnov();
    return el;
  }

  /** Etapy dungeonu jako tabulka: etapa · typ · počet · za hráče · kolik jich přijde pro 1–5 hráčů. */
  function sekceEtap(d, xs) {
    const etapy = S.D.data?.dungeony?.[d]?.etapy || [];
    const radkyEtap = new Map();
    for (const x of xs) {
      const m = x.klic.match(/\.etapa\.(\d+)\.([^.]+)\.(pocet|zaHrace)$/);
      if (!m) continue;
      const kl = `${m[1]}.${m[2]}`;
      if (!radkyEtap.has(kl)) radkyEtap.set(kl, { i: +m[1], t: m[2] });
      radkyEtap.get(kl)[m[3]] = x;
    }
    const maxN = S.D.data?.konstanty?.DUNGEON_HRACU_MAX || 5;
    const ns = Array.from({ length: maxN }, (_, i) => i + 1);
    const tb = h('tbody');
    let posledni = -1;
    for (const r of [...radkyEtap.values()].sort((a, b) => a.i - b.i)) {
      const et = etapy[r.i] || {};
      const pocty = ns.map(() => h('td', { class: 'num' }));
      const obnov = () => ns.forEach((n, j) => {
        const p = (g) => Math.max(0, Math.round((r.pocet ? g(r.pocet.klic) : 0) + (r.zaHrace ? g(r.zaHrace.klic) : 0) * (n - 1)));
        dvojice(pocty[j], p(vych), p(v));
      });
      karty.push({ obnov });
      obnov();
      tb.append(h('tr', { class: r.i !== posledni ? 'nova' : null },
        h('td', {}, r.i !== posledni ? h('span', {}, h('b', {}, `${r.i + 1}. ${et.druh || ''}`), h('br'), h('span', { class: 'muted small' }, et.podtext || '')) : ''),
        h('td', {}, h('span', { class: 'boj-typ' }, ikonaTypu(r.t), nazevTypu(r.t))),
        h('td', {}, r.pocet ? bunka(r.pocet) : ''),
        h('td', {}, r.zaHrace ? bunka(r.zaHrace) : ''),
        ...pocty));
      posledni = r.i;
    }
    return h('section', { class: 'boj-sekce' }, h('h4', {}, 'Etapy'),
      h('div', { class: 'boj-tab-obal' }, h('table', { class: 'boj-tab' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Etapa'), h('th', {}, 'Typ'), h('th', {}, 'Počet'), h('th', {}, 'Za hráče'),
          ...ns.map((n) => h('th', { class: 'num' }, `${n} hr.`)))),
        tb)));
  }

  /** Malé číselné pole do tabulky (etapy, zbraně, kouzla): změna zvýrazněná, výchozí v tooltipu, ↺. */
  function bunka(x) {
    const k = x.klic;
    const vstup = h('input', { type: 'number', min: x.min, max: x.max, step: x.krok ?? 'any', 'aria-label': `${x.popis} (${k})` });
    const reset = h('button', { class: 'boj-reset', title: 'Zpět na výchozí', onclick: () => vratNaVychozi(k) }, '↺');
    const el = h('span', { class: 'boj-bunka' }, vstup, reset);
    vstup.addEventListener('input', () => { if (vstup.value !== '' && Number.isFinite(+vstup.value)) nastav(k, +vstup.value); });
    vstup.addEventListener('blur', () => obnov(true));
    function obnov(i = false) {
      const val = v(k);
      const def = vych(k);
      if (i || document.activeElement !== vstup) vstup.value = val;
      const zmena = !stejne(val, def);
      el.classList.toggle('zmena', zmena);
      el.classList.toggle('spatne', val < x.min || val > x.max);
      vstup.title = `${x.popis}\nvýchozí ${cislo(def, 4)} ${x.jednotka || ''}, rozsah ${cislo(x.min, 4)}–${cislo(x.max, 4)}${x.pozn ? `\n⚠ ${x.pozn}` : ''}\n${k}`;
      reset.hidden = !zmena && !Object.hasOwn(S.koncept, k);
    }
    radky.push({ k, obnov });
    obnov(true);
    return el;
  }

  /** Buňka „výchozí → upravené“ (jen upravené, když jsou stejné). */
  function dvojice(td, a, b, fmt = (x) => cislo(x, 1), lepsi = 0) {
    const ta = typeof a === 'string' ? a : fmt(a);
    const tbx = typeof b === 'string' ? b : fmt(b);
    if (ta === tbx) td.replaceChildren(tbx);
    else {
      const cl = lepsi && typeof a === 'number' && typeof b === 'number' ? ((b - a) * lepsi > 0 ? 'lepsi' : 'horsi') : 'jine';
      td.replaceChildren(h('span', { class: 'muted' }, ta), ' → ', h('b', { class: cl }, tbx));
    }
    return td;
  }

  /** Kompaktní tabulka entit (zbraně, luky, kouzla): řádek = entita, sloupec = pole. */
  function kartaTabulky(nazev, polozky, dps) {
    const pole = [];
    for (const [, hs] of polozky) for (const x of hs) { const p = x.klic.split('.').pop(); if (!pole.some((y) => y.p === p)) pole.push({ p, popis: x.popis, j: x.jednotka }); }
    const tb = h('tbody');
    for (const [id, hs] of polozky) {
      const e = S.D.entity[id];
      const tdDps = h('td', { class: 'num' });
      if (dps) {
        const obnov = () => {
          const f = (g) => { const r = ranaHrace(g, K.postava, id); return r ? (r.rana * 1000) / r.prodleva : NaN; };
          dvojice(tdDps, f(vych), f(v), (x) => cislo(x, 1), 1);
        };
        karty.push({ obnov });
        obnov();
      }
      tb.append(h('tr', {},
        h('td', {}, h('span', { class: 'boj-typ' }, obrazekEntity(id, 32), e?.nazev || id)),
        ...pole.map(({ p }) => { const x = hs.find((y) => y.klic.split('.').pop() === p); return h('td', {}, x ? bunka(x) : ''); }),
        dps ? tdDps : null));
    }
    return h('article', { class: 'boj-karta boj-karta-siroka' },
      h('header', {}, h('div', {}, h('h3', {}, nazev),
        dps ? h('p', { class: 'muted small' }, `Rána za sekundu: ${S.D.entity[`postava.${K.postava}`]?.nazev || K.postava}, rarita ${nazevRarity(K.rarita)}, úroveň zbraně ${K.urovenZbrane ?? K.uroven} (kalkulačka).`) : null)),
      h('div', { class: 'boj-tab-obal' }, h('table', { class: 'boj-tab' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), ...pole.map((x) => h('th', { title: x.popis }, `${kratce(x.popis)}${x.j ? ` (${x.j})` : ''}`)), dps ? h('th', { class: 'num' }, 'Rána/s') : null)),
        tb)));
  }

  // ---------- odvozené ukazatele ----------

  /** Tabulka ukazatel · výchozí → upravené. `radky`: [nazev, fa(g), fmt?, lepsi?, pozn?] */
  function tabOdv(nadpis, rows, navic = null) {
    const tb = h('tbody');
    for (const [n, f, fmt, lepsi, pozn] of rows) {
      let a; let b;
      try { a = f(vych); b = f(v); } catch { a = b = NaN; }
      const td = h('td', { class: 'num' });
      dvojice(td, a, b, fmt || ((x) => cislo(x, 1)), lepsi || 0);
      tb.append(h('tr', {}, h('th', { title: pozn || '' }, n, pozn ? h('span', { class: 'muted' }, ' ⓘ') : null), td));
    }
    return h('div', { class: 'boj-odv' }, h('h4', {}, nadpis), navic, h('table', { class: 'boj-tab boj-tab-odv' }, tb));
  }
  const s = (x) => (Number.isFinite(x) ? `${cislo(x, 1)} s` : '∞');
  const cele = (x) => cislo(x, 0);

  function odvozene(id, stav, prekresli) {
    if (id.startsWith('nepritel.')) return odvNepritel(id.slice(9), stav, prekresli);
    if (id.startsWith('zona.')) return odvZona(id);
    if (id.startsWith('dungeon.') && S.D.data?.dungeony?.[id.slice(8)]) return odvDungeon(id.slice(8));
    if (id.startsWith('postava.')) return odvPostava(id.slice(8));
    if (id.startsWith('korist.') && ma(`${id}.sance`)) return odvKorist(id);
    if (id === 'korist.truhla') return odvKorist(id, 'dungeon.truhla');
    if (id === 'korist.rarity' || id === 'korist') return odvKorist(id, null);
    if (id === 'hrac') {
      return tabOdv('Odvozené', [1, 10, 20, 30].map((u) => [`Životy na ${u}. úrovni (${S.D.entity[`postava.${K.postava}`]?.nazev || ''})`, (g) => maxZivoty(g, u, K.postava), cele, 1]));
    }
    return null;
  }

  function odvNepritel(t, stav, prekresli) {
    const mista = mistaNepritele(v, t);
    if (!stav.misto || !mista.some((m) => m.id === stav.misto)) stav.misto = mista[0].id;
    const vyber = h('select', { class: 'boj-misto', 'aria-label': 'Kde' }, ...mista.map((m) => h('option', { value: m.id, selected: m.id === stav.misto || null }, `${m.nazev} (úr. ${cislo(m.L, 1)})`)));
    vyber.addEventListener('change', () => { stav.misto = vyber.value; prekresli(); });
    const naMiste = (g) => mistaNepritele(g, t).find((m) => m.id === stav.misto) || mistaNepritele(g, t)[0];
    const n = K.hracu;
    const hp = (g) => { const m = naMiste(g); return m.dungeon ? hpVDungeonu(g, m.dungeon, t, n) : hpVeSvete(g, t, m.L); };
    const tlak = (g) => {
      const m = naMiste(g);
      if (!m.dungeon || !S.D.data?.nepratele?.[t]?.tlakHlubin || !ma(`dungeon.${m.dungeon}.pozadavek.sam`)) return { ven: 1, dovnitr: 1 };
      return tlakHlubin(g, m.dungeon, n);
    };
    const boj = (g) => { const m = naMiste(g); const tl = tlak(g); return souboj(g, t, m.L, hp(g), { noc: m.dungeon ? false : K.noc, tlak: tl.dovnitr, ven: tl.ven }); };
    const e = `nepritel.${t}`;
    const r = ranaHrace(v);
    const rows = [
      [mista.find((m) => m.id === stav.misto)?.dungeon ? `Životy (${n} hr.)` : 'Životy', (g) => hp(g), cele],
      [`Ran na zabití${r ? ` (${S.D.entity[zbranKalk()]?.nazev || ''} ${r.rana})` : ''}`, (g) => boj(g).rany, cele, -1],
      ['Čas na zabití', (g) => boj(g).cas, s, -1],
      ['Rána do hráče', (g) => boj(g).doHrace, cele, -1, 'Po obraně z kalkulačky, s vlastnostmi postavy a v noci ×noc. U bosse s tlakem hlubin.'],
      ['Cyklus útoku', (g) => boj(g).cyklus, s, 1, 'nápřah + prodleva'],
      ['Poškození za sekundu', (g) => boj(g).dps, (x) => cislo(x, 1), -1],
      [`Zabije hráče za (${maxZivoty(v, K.uroven, K.postava)} ž.)`, (g) => boj(g).zabijeZa, s, 1, 'Sám, hráč neuhýbá ani neútočí.'],
      ['Nápřah vs. útěk z dosahu', (g) => `${cele(g(`${e}.naprahMs`))} / ${cele(((g(`${e}.dosahUtoku`) * 0.45) / 140) * 1000)} ms`, null, 0, 'Kolik ms se napřahuje proti tomu, za jak dlouho hráč chůzí uteče z dosahu.'],
    ];
    if (ma(`${e}.specialni.polomer`)) rows.push(['Úder do země: nápřah vs. útěk', (g) => `${cele(g(`${e}.specialni.naprahMs`))} / ${cele((g(`${e}.specialni.polomer`) / 140) * 1000)} ms`, null]);
    if (ma(`zkusenosti.${t}`)) rows.push(['XP za zabití', (g) => { const m = naMiste(g); const L = m.dungeon ? g(`dungeon.${m.dungeon}.uroven`) : m.L; return Math.round(g(`zkusenosti.${t}`) * silaNep(g, L, g(`${e}.uroven`)) * (!m.dungeon && K.noc ? g('noc.zkusenosti') : 1)); }, cele, 1]);
    const blok = tabOdv('Odvozené', rows, h('div', { class: 'boj-odv-misto' }, vyber));
    const pretece = hp(v) > UINT16;
    if (pretece) blok.append(h('p', { class: 'err small' }, `Životy ${cele(hp(v))} přetečou (uint16, nejvýš ${UINT16}).`));
    if (t !== 'strazce' && t !== 'arcibiskup') blok.append(h('p', { class: 'muted small' }, 'Šašek v masce tohohle nepřítele bere jeho staty taky.'));
    return blok;
  }

  function tlakHlubin(g, d, n) {
    const sam = g(`dungeon.${d}.pozadavek.sam`);
    const troj = g(`dungeon.${d}.pozadavek.trojice`);
    const pozadovana = Math.round(sam + ((troj - sam) * (Math.min(3, n) - 1)) / 2);
    const pod = Math.max(0, pozadovana - K.uroven);
    const ven = Math.max(g('dungeon.tlak.minVen'), 1 - g('dungeon.tlak.zaUroven') * pod);
    const dovnitr = Math.min(g('dungeon.tlak.maxDovnitr'), 1 + g('dungeon.tlak.zaUroven') * pod) / (1 + g('dungeon.tlak.parta') * (Math.min(5, n) - 1));
    return { pozadovana, pod, ven, dovnitr };
  }

  function odvZona(z) {
    const info = S.D.entity[z].info || {};
    /** Očekávaný počet nepřátel podle typu. */
    const pocty = (g) => {
      const o = {};
      const varianty = parseSkupiny(g(`${z}.skupiny`)).filter((x) => x.every((t) => ma(`nepritel.${t}.zivoty`)));
      const sk = Math.min(g(`${z}.skupinek`), info.volneTabory ?? Infinity);
      if (varianty.length) for (const var1 of varianty) for (const t of var1) o[t] = (o[t] || 0) + (sk * smeckaPrumer(g, t)) / varianty.length;
      for (const d of info.doupata || []) for (const t of d.skupina) o[t] = (o[t] || 0) + smeckaPrumer(g, t);
      return o;
    };
    const L = (g) => prumerZony(g, z);
    const zaMin = (g) => {
      const o = pocty(g);
      let strop = 0; let real = 0; let xp = 0;
      for (const [t, n] of Object.entries(o)) {
        const resp = g(`nepritel.${t}.znovuobjeveniMs`);
        if (!resp) continue;
        strop += (n * 60000) / resp;
        const b = souboj(g, t, L(g), hpVeSvete(g, t, L(g)));
        const r = (n * 60) / (resp / 1000 + (b.cas ?? 0));
        real += r;
        xp += r * Math.round((g(`zkusenosti.${t}`) ?? 0) * silaNep(g, L(g), g(`nepritel.${t}.uroven`)) * (K.noc ? g('noc.zkusenosti') : 1));
      }
      return { strop, real, xp };
    };
    const prahy = S.D.data?.prahy || [];
    const u = K.uroven;
    const potreba = u < prahy.length ? prahy[u] - prahy[u - 1] : null;
    const rows = [
      ['Úroveň nepřátel', (g) => `${g(`${z}.uroven_od`)}–${Math.max(g(`${z}.uroven_od`), g(`${z}.uroven_do`))}`],
      ['Očekávaných nepřátel', (g) => Object.values(pocty(g)).reduce((a, b) => a + b, 0), (x) => cislo(x, 1)],
      ['Z toho', (g) => Object.entries(pocty(g)).map(([t, n]) => `${nazevTypu(t)} ${cislo(n, 1)}`).join(' · ') || '–'],
      ['Nepřátel/min (strop)', (g) => zaMin(g).strop, (x) => cislo(x, 1), 0, 'Kdyby hráč zabíjel hned, jak se objeví.'],
      ['Nepřátel/min (reálně)', (g) => zaMin(g).real, (x) => cislo(x, 1), 0, 'Pro hráče z kalkulačky, jen když stíhá obcházet tábory.'],
      ['XP/min', (g) => zaMin(g).xp, cele, 1],
      [`Minut na ${u + 1}. úroveň`, (g) => (potreba ? potreba / zaMin(g).xp : NaN), (x) => cislo(x, 1), -1, potreba ? `Potřeba ${potreba} XP z úrovně ${u}.` : 'Nejvyšší úroveň.'],
    ];
    const blok = tabOdv('Odvozené', rows);
    const od = v(`${z}.uroven_od`);
    const rozdilUr = od - K.uroven;
    blok.prepend(h('p', { class: `small boj-urzony ${rozdilUr >= 3 ? 'err' : rozdilUr <= -3 ? 'muted' : ''}` },
      rozdilUr >= 3 ? `Zóna je o ${rozdilUr} úrovně výš než hráč (${K.uroven}).` : rozdilUr <= -3 ? `Zóna je pro hráče ${K.uroven}. úrovně slabá.` : `Zóna sedí hráči ${K.uroven}. úrovně.`));
    return blok;
  }

  function odvDungeon(d) {
    const dd = S.D.data.dungeony[d];
    const D = `dungeon.${d}`;
    const maxN = S.D.data?.konstanty?.DUNGEON_HRACU_MAX || 5;
    const ns = Array.from({ length: maxN }, (_, i) => i + 1);
    const etapaTypy = (i) => {
      const typy = new Set(dd.etapy[i]?.typy || []);
      for (const x of S.D.hodnoty) { const m = x.klic.match(new RegExp(`^${D.replace('.', '\\.')}\\.etapa\\.${i}\\.([^.]+)\\.pocet$`)); if (m) typy.add(m[1]); }
      return [...typy];
    };
    const pocet = (g, i, t, n) => Math.max(0, Math.round((g(`${D}.etapa.${i}.${t}.pocet`) ?? 0) + (g(`${D}.etapa.${i}.${t}.zaHrace`) ?? 0) * (n - 1)));
    const etapy = dd.etapy.map((et, i) => ({ ...et, i, typy: etapaTypy(i) }));
    const r0 = (g) => ranaHrace(g);
    const casEtapy = (g, e, n) => {
      const r = r0(g);
      if (!r) return NaN;
      let sum = 0; let kusu = 0; let ven = 1;
      for (const t of e.typy) {
        const p = pocet(g, e.i, t, n);
        kusu += p;
        sum += p * hpVDungeonu(g, d, t, n);
        if (S.D.data?.nepratele?.[t]?.tlakHlubin) ven = tlakHlubin(g, d, n).ven;
      }
      const rana = Math.max(1, Math.round(r.rana * ven));
      return sum / ((n * rana * 1000) / r.prodleva) + g('dungeon.pauzaMs') / 1000 + (kusu * g('dungeon.vyvolaniKrokMs')) / 1000;
    };
    const tb = h('tbody');
    const radekN = (nazev, f, fmt = cele, lepsi = 0, pozn = '') => {
      tb.append(h('tr', {}, h('th', { title: pozn }, nazev, pozn ? h('span', { class: 'muted' }, ' ⓘ') : null),
        ...ns.map((n) => { const td = h('td', { class: `num${n === K.hracu ? ' vybrany' : ''}` }); let a; let b; try { a = f(vych, n); b = f(v, n); } catch { a = b = NaN; } return dvojice(td, a, b, fmt, lepsi); })));
    };
    for (const e of etapy) {
      radekN(`${e.i + 1}. ${e.druh}: kusů`, (g, n) => e.typy.reduce((a, t) => a + pocet(g, e.i, t, n), 0));
      radekN('  životy celkem', (g, n) => e.typy.reduce((a, t) => a + pocet(g, e.i, t, n) * hpVDungeonu(g, d, t, n), 0));
      if (e.druh === 'boss') {
        for (const t of e.typy) {
          radekN(`  ${nazevTypu(t)}: životy`, (g, n) => hpVDungeonu(g, d, t, n));
          if (S.D.data?.nepratele?.[t]?.tlakHlubin) {
            radekN('  rána bosse do tebe', (g, n) => ranaDoHrace(g, t, g(`${D}.sila`), { noc: false, tlak: tlakHlubin(g, d, n).dovnitr }), cele, -1, `Tlak hlubin pro hráče ${K.uroven}. úrovně.`);
            radekN('  tvoje rána ×', (g, n) => tlakHlubin(g, d, n).ven, (x) => cislo(x, 2), 1);
          }
        }
      }
      radekN('  čas na vyčištění', (g, n) => casEtapy(g, e, n), s, -1, 'Hrubě: životy / (hráčů × rána za s) + pauza + vylézání.');
    }
    radekN('Celý průchod', (g, n) => etapy.reduce((a, e) => a + casEtapy(g, e, n), 0), (x) => (Number.isFinite(x) ? `${cislo(x / 60, 1)} min` : '–'), -1);
    radekN('XP na hráče', (g, n) => etapy.reduce((a, e) => a + e.typy.reduce((b, t) => b + pocet(g, e.i, t, n) * Math.round((g(`zkusenosti.${t}`) ?? 0) * silaNep(g, g(`${D}.uroven`), g(`nepritel.${t}.uroven`))), 0), 0), cele, 1, 'Každý v partě dostane plné.');
    radekN('Kořist na zem', (g, n) => etapy.reduce((a, e) => a + e.typy.reduce((b, t) => b + (ma(`korist.${t}.sance`)
      ? (pocet(g, e.i, t, n) * g(`korist.${t}.sance`)) / 100 * ((dd.horda || []).includes(t) ? g('dungeon.koristZHordy') : 1) : 0), 0), 0)
      + (ma('dungeon.truhla.predmetu') ? (g('dungeon.truhla.predmetu') * g('dungeon.truhla.sance')) / 100 : 0), (x) => cislo(x, 1), 1, 'Včetně truhly.');
    radekN('Úroveň kořisti', (g, n) => { const tl = tlakHlubin(g, d, n); return Math.max(1, Math.min(g(`${D}.uroven`), K.uroven + Math.min(5, Math.floor(tl.pod / 3)))); }, cele, 1, `Nejvyšší v partě = ${K.uroven} (kalkulačka).`);
    radekN('Přízeň (epické ×)', (g, n) => Math.min(2, 1 + 0.08 * tlakHlubin(g, d, n).pod), (x) => cislo(x, 2), 1);
    const blok = h('div', { class: 'boj-odv' }, h('h4', {}, `Odvozené pro 1–${maxN} hráčů (hráč ${K.uroven}. úrovně)`),
      h('div', { class: 'boj-tab-obal' }, h('table', { class: 'boj-tab boj-tab-odv boj-tab-n' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), ...ns.map((n) => h('th', { class: 'num' }, `${n} hr.`)))), tb)));
    const najednou = v('dungeon.najednouMax');
    for (const e of etapy) {
      const kusu = e.typy.reduce((a, t) => a + pocet(v, e.i, t, maxN), 0);
      if (kusu > najednou) blok.append(h('p', { class: 'small muted' }, `Etapa ${e.i + 1}: pro ${maxN} hráčů ${kusu} kusů, víc než ${najednou} naráz, zbytek čeká ve frontě.`));
      for (const t of e.typy) if (hpVDungeonu(v, d, t, maxN) > UINT16) blok.append(h('p', { class: 'small err' }, `${nazevTypu(t)}: životy pro ${maxN} hráčů přetečou (uint16).`));
    }
    return blok;
  }

  function odvPostava(p) {
    const st = S.D.entity[`postava.${p}`]?.info?.start?.zbran;
    const zb = st ? `zbran.${st}` : null;
    const rows = [
      [`Životy na ${K.uroven}. úrovni`, (g) => maxZivoty(g, K.uroven, p), cele, 1],
      ['Rychlost chůze', (g) => (S.D.data?.konstanty?.RYCHLOST_CHUZE || 140) + (g(`postava.${p}.rychlost`) ?? 0), (x) => `${cele(x)} px/s`, 1],
    ];
    if (zb && S.D.entity[zb]) {
      rows.push([`Rána: ${S.D.entity[zb].nazev}`, (g) => ranaHrace(g, p, zb)?.rana, cele, 1]);
      rows.push(['Rána za sekundu', (g) => { const r = ranaHrace(g, p, zb); return r ? (r.rana * 1000) / r.prodleva : NaN; }, (x) => cislo(x, 1), 1]);
    }
    if (p === 'lovec') {
      const luk = S.D.entity[`postava.${p}`]?.info?.start?.nadalku;
      if (luk && S.D.entity[`luk.${luk}`]) rows.push([`${S.D.entity[`luk.${luk}`].nazev}: zblízka–zdálky`, (g) => { const r = ranaHrace(g, p, `luk.${luk}`); return r?.rozsah ? `${r.rozsah[0]}–${r.rozsah[1]}` : String(r?.rana ?? '–'); }]);
    }
    if (ma('nepritel.skret.zivoty') && zb) {
      rows.push(['Ran na skřeta 1. úrovně', (g) => { const r = ranaHrace(g, p, zb); return r ? Math.ceil(hpVeSvete(g, 'skret', 1) / r.rana) : NaN; }, cele, -1]);
    }
    return tabOdv('Odvozené (bez stromu a vlastností předmětů)', rows);
  }

  function vahyRarit(g, tab, u) {
    const rar = S.D.data?.rarity || [];
    const vlastni = tab && rar.some((r) => ma(`${tab}.rarity.${r}`));
    const w = rar.map((r) => {
      const zakl = vlastni ? (ma(`${tab}.rarity.${r}`) ? g(`${tab}.rarity.${r}`) : 0) : g(`rarita.${r}.sance`);
      return u < g(`rarita.${r}.odUrovne`) ? 0 : zakl * (1 + g(`rarita.${r}.zaUroven`) * (u - 1));
    });
    const sum = w.reduce((a, b) => a + b, 0) || 1;
    return Object.fromEntries(rar.map((r, i) => [r, (w[i] / sum) * 100]));
  }

  function odvKorist(id, tab = id) {
    const rar = S.D.data?.rarity || [];
    const urovne = [1, 5, 10, 15, 20, 30];
    const tb = h('tbody');
    for (const r of rar) {
      tb.append(h('tr', {}, h('th', {}, nazevRarity(r)), ...urovne.map((u) => dvojice(h('td', { class: 'num' }), vahyRarit(vych, tab, u)[r], vahyRarit(v, tab, u)[r], (x) => `${cislo(x, 1)} %`))));
    }
    const blok = h('div', { class: 'boj-odv' }, h('h4', {}, 'Rarita podle úrovně předmětu'),
      h('div', { class: 'boj-tab-obal' }, h('table', { class: 'boj-tab boj-tab-odv boj-tab-n' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), ...urovne.map((u) => h('th', { class: 'num' }, `úr. ${u}`)))), tb)));
    if (!tab) return blok;
    const u = K.uroven;
    const pasma = S.D.data?.pasmaStupnu || [];
    const stupne = (g) => {
      const pasmo = u <= 2 ? 0 : u <= 5 ? 1 : u <= 9 ? 2 : 3;
      return pasma[Math.min(pasma.length - 1, pasmo + (ma(`${tab}.posun`) ? g(`${tab}.posun`) : 0))] || [];
    };
    const ep = (g) => { const w = vahyRarit(g, tab, u); return (w.epicka || 0) + (w.legendarni || 0); };
    const t = id.slice(7);
    const rows = [
      [`Stupně 1/2/3 na úrovni ${u}`, (g) => stupne(g).map((x) => `${x} %`).join(' / ')],
      [`Epická+ z jednoho ${id === 'korist.truhla' ? 'předmětu' : 'zabití'} (úr. ${u})`, (g) => ((g(`${tab}.sance`) ?? 100) / 100) * ep(g), (x) => `${cislo(x, 2)} %`, 1],
    ];
    const zl = id === 'korist.truhla' ? 'zlataky.truhla' : `zlataky.${t}`;
    if (ma(`${zl}.od`)) rows.push([`Zlaťáků průměrně (úr. ${u})`, (g) => ((g(`${zl}.od`) + g(`${zl}.do`)) / 2) * (1 + g('zlataky.zaUroven') * (u - 1)) * ((ma(`${zl}.sance`) ? g(`${zl}.sance`) : 100) / 100), (x) => cislo(x, 1), 1]);
    blok.append(tabOdv(`Na úrovni ${u} (kalkulačka)`, rows));
    blok.append(h('p', { class: 'muted small' }, 'Ochrana proti smůle se nepočítá.'));
    return blok;
  }

  // ---------- rozdíl a uložení ----------

  function popisZmeny({ k, stare, nove }) {
    const x = meta(k);
    const ent = x ? S.D.entity[x.entita]?.nazev || x.entita : 'neznámý klíč';
    const co = x ? kratce(x.popis) : k;
    const def = x ? x.vychozi : undefined;
    const fmt = (val) => (val === undefined ? (def === undefined ? '∅' : String(def)) : String(val));
    return { ent, co, def, z: fmt(stare), na: fmt(nove), zpet: nove === undefined };
  }

  function zpravaCommitu(zmeny, poznamka) {
    const n = zmeny.length;
    const radkyZpr = zmeny.map((d) => {
      const p = popisZmeny(d);
      return `- ${p.ent} · ${p.co}: ${p.z} → ${p.na}${p.zpet ? ' (zpět na výchozí)' : ''}`;
    });
    return `Balanc z nástěnky: ${n} ${n === 1 ? 'změna' : n < 5 ? 'změny' : 'změn'}\n\n${radkyZpr.join('\n')}${poznamka ? `\n\n${poznamka}` : ''}\n`;
  }

  function tabulkaRozdilu(zmeny) {
    return h('div', { class: 'boj-tab-obal' }, h('table', { class: 'boj-tab boj-rozdil' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Entita'), h('th', {}, 'Hodnota'), h('th', { class: 'num' }, 'Výchozí'), h('th', { class: 'num' }, 'Uloženo → nové'), h('th', { class: 'num' }, 'Δ'))),
      h('tbody', {}, ...zmeny.map((d) => {
        const p = popisZmeny(d);
        const nove = d.nove === undefined ? p.def : d.nove;
        const dl = typeof nove === 'number' && typeof p.def === 'number' && p.def ? ((nove - p.def) / p.def) * 100 : null;
        return h('tr', { class: p.zpet ? 'zpet' : null },
          h('td', {}, p.ent),
          h('td', { title: d.k }, p.co, h('br'), h('code', { class: 'small' }, d.k)),
          h('td', { class: 'num muted' }, p.def === undefined ? '–' : String(p.def)),
          h('td', { class: 'num' }, h('span', { class: 'muted' }, d.stare === undefined ? 'výchozí' : String(d.stare)), ' → ',
            p.zpet ? h('s', {}, 'zpět na výchozí') : h('b', {}, String(d.nove))),
          h('td', { class: 'num' }, dl == null || p.zpet ? '' : `${dl > 0 ? '+' : dl < 0 ? '−' : ''}${cislo(Math.abs(dl), 1)} %`));
      }))));
  }

  function otevriRozdil(ukladat) {
    const zmeny = rozdil();
    if (!zmeny.length) return toast('Žádné změny.');
    const poz = h('textarea', { rows: 2, placeholder: 'Např. Luka byla moc lehká, skřeti víc vydrží.' });
    poz.value = S.posledniPoznamka || '';
    const err = h('p', { class: 'err' });
    const btn = h('button', { class: 'btn primary' }, 'Uložit do hry');
    btn.onclick = async () => {
      btn.disabled = true;
      err.textContent = '';
      try {
        await uloz(poz.value.trim());
        dlg.close();
      } catch (e) {
        err.textContent = e.message;
      } finally { btn.disabled = false; }
    };
    const prazdne = !Object.keys(novePrepisy()).length;
    dlg.replaceChildren(h('div', { class: 'boj-dlg-telo' },
      h('h2', {}, ukladat ? 'Uložit do hry' : 'Rozdíl proti hře'),
      tabulkaRozdilu(zmeny),
      ukladat ? h('label', { class: 'boj-proc' }, h('span', { class: 'muted small' }, 'Proč (nepovinné, půjde do popisu změny)'), poz) : null,
      ukladat ? h('p', { class: 'muted small' }, prazdne
        ? `Všechno bude zase výchozí, takže se ${BALANC} smaže.`
        : `Zapíše se ${BALANC} do větve ${CFG.branch}. Lokálně se server restartuje sám po git pull, veřejný server až po nasazení („nasaď na server“).`) : null,
      err,
      h('div', { class: 'row end' },
        h('button', { class: 'btn', onclick: () => dlg.close() }, ukladat ? 'Zrušit' : 'Zavřít'),
        ukladat ? btn : h('button', { class: 'btn primary', onclick: () => otevriRozdil(true) }, 'Uložit do hry…'))));
    if (!dlg.open) dlg.showModal();
  }

  async function uloz(poznamka) {
    const zmeny = rozdil();
    if (!zmeny.length) return;
    const prepisy = novePrepisy();
    const message = zpravaCommitu(zmeny, poznamka);
    const cesta = `${REPO}/contents/${encPath(BALANC)}`;
    let res;
    try {
      if (!Object.keys(prepisy).length) {
        if (S.zaklad) res = await gh(cesta, { method: 'DELETE', body: { message, sha: S.zaklad, branch: CFG.branch } });
      } else {
        const vpu = {};
        for (const k of Object.keys(prepisy)) if (ma(k)) vpu[k] = vych(k);
        const o = {
          verze: 1,
          upraveno: new Date().toISOString(),
          autor: me()?.login || null,
          ...(poznamka ? { poznamka } : {}),
          prepisy,
          vychoziPriUlozeni: serad(vpu),
        };
        res = await gh(cesta, {
          method: 'PUT',
          body: { message, content: doBase64(JSON.stringify(o, null, 2) + '\n'), branch: CFG.branch, ...(S.zaklad ? { sha: S.zaklad } : {}) },
        });
        S.vpu = o.vychoziPriUlozeni;
        S.autor = o.autor; S.upraveno = o.upraveno; S.poznamka = poznamka;
      }
    } catch (e) {
      if (e.status === 409 || e.status === 422) return konflikt(poznamka);
      throw e;
    }
    S.zaklad = res?.content?.sha || null;
    S.ulozeno = prepisy;
    if (!Object.keys(prepisy).length) { S.vpu = {}; S.autor = me()?.login || null; S.upraveno = new Date().toISOString(); S.poznamka = poznamka; }
    S.koncept = {};
    S.posledniPoznamka = '';
    ulozKoncept();
    vykresli();
    toast(`Uloženo do ${CFG.branch}. Lokálně se server restartuje sám po git pull, na veřejném serveru až po nasazení („nasaď na server“).`);
  }

  /** Někdo mezitím uložil: načíst jeho stav, rozpracované nechat nahoře a ukázat, co změnili oba. */
  async function konflikt(poznamka) {
    S.posledniPoznamka = poznamka;
    const stare = S.ulozeno;
    await nactiBalanc();
    const kdo = jmeno(S.autor);
    const spory = [];
    for (const [k, moje] of Object.entries(S.koncept)) {
      const jejich = S.ulozeno[k];
      if (!stejne(stare[k], jejich) && !stejne(moje === null ? undefined : moje, jejich)) spory.push({ k, moje, jejich });
    }
    for (const k of Object.keys(S.koncept)) if (S.koncept[k] !== null && stejne(S.koncept[k], ulozenaHodnota(k))) delete S.koncept[k];
    ulozKoncept();
    vykresli();
    if (!spory.length) {
      toast(`${kdo} mezitím uložil/a balanc. Tvoje změny jsou nad jeho stavem, zkontroluj a ulož znovu.`);
      return otevriRozdil(true);
    }
    const volby = spory.map((sp) => {
      const p = popisZmeny({ k: sp.k, stare: sp.jejich, nove: sp.moje === null ? undefined : sp.moje });
      const nazev = `spor-${sp.k}`;
      const moje = h('input', { type: 'radio', name: nazev, checked: true });
      const jejich = h('input', { type: 'radio', name: nazev });
      return {
        sp, moje,
        el: h('div', { class: 'boj-spor' },
          h('p', {}, h('b', {}, `${p.ent} · ${p.co}`), ': ', `${kdo} mezitím nastavil/a ${sp.jejich === undefined ? 'výchozí' : sp.jejich}, ty máš ${sp.moje === null ? 'výchozí' : sp.moje}. Které?`),
          h('label', {}, moje, ` moje (${sp.moje === null ? 'výchozí' : sp.moje})`),
          h('label', {}, jejich, ` ${kdo} (${sp.jejich === undefined ? 'výchozí' : sp.jejich})`)),
      };
    });
    dlg.replaceChildren(h('div', { class: 'boj-dlg-telo' },
      h('h2', {}, 'Někdo uložil dřív'),
      h('p', { class: 'muted' }, `${kdo} mezitím uložil/a balanc. Tyhle hodnoty jste změnili oba:`),
      ...volby.map((x) => x.el),
      h('div', { class: 'row end' },
        h('button', { class: 'btn', onclick: () => dlg.close() }, 'Zrušit'),
        h('button', {
          class: 'btn primary',
          onclick: () => {
            for (const x of volby) if (!x.moje.checked) delete S.koncept[x.sp.k];
            ulozKoncept();
            vykresli();
            otevriRozdil(true);
          },
        }, 'Pokračovat'))));
    if (!dlg.open) dlg.showModal();
  }

  function zahodit() {
    const n = rozdil().length;
    if (!n || !confirm(`Zahodit ${n} rozpracovaných změn? Ve hře se nic nezmění.`)) return;
    S.koncept = {};
    ulozKoncept();
    vykresli();
  }

  // ---------- veřejné ----------

  return {
    el: koren,
    ukaz() {
      koren.hidden = false;
      if (!S.nacteno && !S.nacitam) nacti();
    },
    skryj() { koren.hidden = true; },
  };
}
