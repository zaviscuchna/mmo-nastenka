# Pro Clauda: nástěnka MMO RPG

Nástěnku si upravuje tým sám (Záviš, Vojta, Tomáš), každý přes svůj Claude Code.
**Žádné issues, PR ani schvalování.** Když člověk řekne, co chce změnit, udělej to,
vyzkoušej a nahraj rovnou do `main`. Neptej se, jestli založit úkol.

## Postup
1. `git pull --rebase` (pracují na tom tři lidi zároveň)
2. Uprav, vyzkoušej lokálně: `python3 -m http.server 8000` → http://localhost:8000
   (přihlášení vlastním klíčem, jede to nad skutečnými daty, testovací příspěvky
   pojmenuj `TEST …` a po sobě je smaž tlačítkem 🗑)
3. `bash scripts/check.sh`
4. `git commit` + `git push` do `main`. Když push odmítne kvůli novějším změnám:
   `git pull --rebase` a znovu.
5. GitHub sám spustí kontrolu a do ~1 minuty nasadí. **Když kontrola neprojde, nenasadí
   se nic a zůstává předchozí verze.** Ověř `gh run list -R zaviscuchna/mmo-nastenka --limit 1`
   a když je neúspěch, oprav to hned.

Uživateli pak řekni jednou větou, co je jinak, a že je to na
https://zaviscuchna.github.io/mmo-nastenka/ (obnovit stránku).

## Jak to funguje
- Statická stránka bez buildu: `index.html`, `style.css`, `app.js` (vanilla JS, ES modul).
- Data NEJSOU tady. Jsou v soukromém repu `zaviscuchna/mmo-rpg` a nástěnka je čte
  a zapisuje přes GitHub API klíčem přihlášeného člověka:
  - příspěvek = issue se štítkem `nápad`, `grafika`, `rozhodnutí` nebo `stavba`
  - stav = štítek `diskuse` / `schváleno` / `zamítnuto`, bez štítku = nový
  - skrytý (smazaný ne-správcem) = štítek `smazáno`
  - hlas = reakce 👍 / 👎 na issue
  - obrázky = soubory v `board/navrhy/…/vN.ext`, seznam je v těle issue
    v komentáři `<!-- nastenka {"files":[...]} -->`
  - schválená grafika se kopíruje do `docs/art/<kategorie>/`
  - rozhodnutí: možnosti v `{"options":[...]}`, hlas = komentář `<!-- hlas {"o":N} -->`
    (jeden na člověka, změna = úprava komentáře), po uzavření `winner` + `record`
    a zápis `docs/rozhodnuti/NNN-nazev.md`
  - stavba (úkol): kdo dělá = assignee, hotovo = zavřené issue, postup = `- [x]` v těle,
    závislosti = řádek `Závisí na: #12, #13`. Tenhle formát používá i Claude v herním repu
    (viz jeho `CLAUDE.md`), takže ho neměň bez úpravy obou míst.
- Nastavení (repo, tým, jména) je v `CFG` na začátku `app.js`.

## Co se NESMÍ rozbít
1. **Formát dat výše.** Existující příspěvky musí jít dál číst. Když formát měníš,
   nová verze musí umět i ten starý.
2. **Klíč (token).** Posílá se jen na `api.github.com`. Žádné další servery, analytika,
   skripty z cizích CDN. Repo je veřejné. `scripts/check.sh` to hlídá.
3. **Uživatelský text jen přes `textContent`** (helper `h()`), nikdy přes `innerHTML`.
   Jinak by kdokoli mohl do nápadu vložit skript a ukrást ostatním klíč.
4. **Pixel art** se zvětšuje jen celými násobky a s `image-rendering: pixelated`.
5. Čeština v UI, tón stručný a lidský.

## Styl kódu
Drž se toho, co v `app.js` je: malé funkce, helper `h()` na DOM, `gh()` na API,
komentář jen tam, kde je důvod neviditelný z kódu. Žádný framework ani build krok.
