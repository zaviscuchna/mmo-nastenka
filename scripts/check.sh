#!/usr/bin/env bash
# Kontrola před nasazením: syntaxe + hlídání, kam smí stránka posílat data.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0

node --check app.js || fail=1

# Povolené adresy: GitHub (API, avatary, odkazy) a Google Fonts.
allowed='^https://(api\.github\.com|github\.com|avatars\.githubusercontent\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|zaviscuchna\.github\.io)'
bad=$(grep -ohE "https?://[a-zA-Z0-9.-]+" index.html app.js style.css | sort -u | grep -vE "$allowed" | grep -v "www.w3.org" || true)
if [ -n "$bad" ]; then echo "❌ Nepovolené adresy (klíč smí jít jen na GitHub):"; echo "$bad"; fail=1; fi

if grep -nE "\.innerHTML\s*=|insertAdjacentHTML|document\.write" app.js; then
  echo "❌ innerHTML / insertAdjacentHTML / document.write: uživatelský text jen přes h() a textContent"; fail=1
fi

if grep -nE "<script[^>]+src=\"https?://" index.html; then echo "❌ Skript z cizího serveru"; fail=1; fi

[ $fail = 0 ] && echo "✅ Kontrola prošla"
exit $fail
