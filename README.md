# MMO nástěnka

Vizuální nástěnka pro nápady a návrhy grafiky k naší hře.
Běží na https://zaviscuchna.github.io/mmo-nastenka/

Tohle repo obsahuje **jen kód stránky** a je veřejné, protože GitHub Pages
na bezplatném účtu jinak nejde. Všechna data (nápady, obrázky, hlasy, komentáře)
jsou v soukromém repu `zaviscuchna/mmo-rpg` a nástěnka k nim přistupuje
přes GitHub API klíčem přihlášeného člověka. Bez přístupu k `mmo-rpg` neuvidíš nic.

- `index.html`, `style.css`, `app.js`: vanilla JS, žádný build
- nastavení týmu a repa je na začátku `app.js` (`CFG`)
- lokálně: `python3 -m http.server` a otevřít `http://localhost:8000`

## Vylepšování
Nástěnku si vylepšujeme sami. Nápad → tlačítko 💡 na nástěnce nebo issue tady.
Pak ho kdokoli dá svému Claude Code (`vezmi issue #N z mmo-nastenka`). Pravidla jsou v [`CLAUDE.md`](CLAUDE.md).
Každý push do `main` je do minuty živě.
