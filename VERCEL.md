# Wdrożenie na Vercel

Wskaż jako **Root Directory** folder zawierający bezpośrednio pliki
`index.html`, `vercel.json` i katalog `api`. Nie wskazuj folderu nadrzędnego.

Ustawienia projektu w Vercel:

- Framework Preset: `Other`
- Build Command: pozostaw puste
- Output Directory: pozostaw puste
- Install Command: pozostaw domyślne

Po wdrożeniu dostępne będą:

- `/` — strona główna
- `/api/flight?callsign=MLM712` — dane lotu
- `/api/weather?station=EKVG` — dane pogodowe

Projekt nie wymaga kluczy API ani zmiennych środowiskowych. `server.js` służy
wyłącznie do uruchamiania lokalnego i jest pomijany podczas wdrożenia.
