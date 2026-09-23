# Pro Clauda: nástěnka MMO RPG

Tuhle nástěnku si vylepšuje tým sám (Záviš, Vojta, Tomáš), každý přes svůj Claude Code.
Úkoly jsou issues v tomhle repu se štítkem `vylepšení` nebo `chyba`. Zakládají se i tlačítkem 💡
přímo na nástěnce.

## Jak to funguje
- Statická stránka bez buildu: `index.html`, `style.css`, `app.js` (vanilla JS, ES modul).
- Běží na GitHub Pages: **každý push do `main` je do minuty živě pro všechny.**
- Data NEJSOU tady. Jsou v soukromém repu `zaviscuchna/mmo-rpg` a nástěnka je čte
  a zapisuje přes GitHub API klíčem přihlášeného člověka:
  - příspěvek = issue se štítkem `nápad` nebo `grafika`
  - stav = štítek `diskuse` / `schváleno` / `zamítnuto`, bez štítku = nový
  - skrytý (smazaný ne-správcem) = štítek `smazáno`
  - hlas = reakce 👍 / 👎 na issue
  - obrázky = soubory v `board/navrhy/…/vN.ext`, seznam je v těle issue
    v komentáři `<!-- nastenka {"files":[...]} -->`
  - schválená grafika se kopíruje do `docs/art/<kategorie>/`
- Nastavení (repo, tým, jména) je v `CFG` na začátku `app.js`.

## Co se NESMÍ rozbít
1. **Formát dat výše.** Existující issues musí jít dál číst. Když formát měníš,
   musí nová verze umět i ten starý.
2. **Klíč (token).** Posílá se jen na `api.github.com`. Žádné další servery, analytika,
   skripty z cizích CDN. Repo je veřejné. Kontrola `scripts/check.sh` to hlídá.
3. **Uživatelský text jen přes `textContent`** (helper `h()`), nikdy přes `innerHTML`.
   Jinak by kdokoli mohl do nápadu vložit skript a ukrást ostatním klíč.
4. **Pixel art** se zvětšuje jen celými násobky a s `image-rendering: pixelated`.
5. Čeština v UI, tón stručný a lidský.

## Jak pracovat
1. Vezmi issue, udělej větev `vylepseni/<cislo>-<kratce>`.
2. Vyzkoušej lokálně:
   ```
   python3 -m http.server 8000
   ```
   a otevři http://localhost:8000. Přihlášení vlastním klíčem, pracuje se **nad skutečnými
   daty**, takže testovací příspěvky pojmenuj `TEST …` a po sobě je smaž (🗑 na nástěnce).
3. Spusť `bash scripts/check.sh`. Stejnou kontrolu pouští GitHub u každého PR.
4. Otevři PR s `Closes #<cislo>` a krátkým popisem, co je jinak **pro uživatele**.
   Přidej screenshot, pokud jde o vzhled. Ostatní dostanou upozornění.
5. Mergnout smí autor sám, pokud kontrola prošla a změna je malá (vzhled, texty, drobnost).
   Větší věci (formát dat, přihlášení, mazání) nech aspoň jednoho dalšího přečíst.

## Styl kódu
Drž se toho, co v `app.js` je: malé funkce, helper `h()` na DOM, `gh()` na API,
komentář jen tam, kde je důvod neviditelný z kódu. Žádný framework ani build krok.
