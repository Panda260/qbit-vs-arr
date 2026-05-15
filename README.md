# qbit-vs-arr

**qbit-vs-arr** is a powerful, high-performance media synchronization dashboard. It automatically scans your multiple Radarr and Sonarr instances and cross-references them with your qBittorrent client to find "Missing Media" (media imported into *Arr but no longer seeding in qBittorrent). 

It is primarily built for users running **Cross-Seed** or complex multi-tracker setups who want to ensure they haven't accidentally deleted torrents they are supposed to be seeding.

## Features
- **Multi-Instance Support**: Connect an unlimited number of Radarr and Sonarr instances seamlessly.
- **Intelligent Matching**: Uses a highly optimized algorithm to match *Arr files with Torrent names, gracefully handling complex Scene naming conventions, P2P release group suffixes, and missing Umlauts (handles German & English variations).
- **Lightning Fast**: Pre-calculated string normalizations ensure that comparing thousands of torrents against thousands of movies/series completes in milliseconds.
- **Tag Filtering**: Filter your media by any tag automatically pulled from qBittorrent.
- **Global Ignore List**: Persistently hide files or paths that shouldn't be tracked (e.g., manually handled remuxes or un-seedable paths).
- **Cross-Seed Integration**: One-click UI buttons to instantly copy cross-seed injection commands for specific missing files.
- **Real-Time Scanning**: Live Server-Sent Events (SSE) provide instant UI feedback during backend scans so you always know what instance is currently being processed.

## Setup & Installation

### Option 1: Docker Compose (Recommended)

Create a `docker-compose.yml` file:
```yaml
services:
  qbit-vs-arr:
    image: ghcr.io/panda260/qbit-vs-arr:latest
    container_name: qbit-vs-arr
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

Then start the container:
```bash
docker compose up -d
```

### Option 2: Docker CLI

```bash
docker run -d \
  --name=qbit-vs-arr \
  -p 3000:3000 \
  -v ./data:/app/data \
  --restart unless-stopped \
  ghcr.io/panda260/qbit-vs-arr:latest
```

3. Access the dashboard at `http://localhost:3000`.

## Configuration
On your first visit, navigate to the **Settings** page:
1. Add your qBittorrent connection details (URL, Username, Password).
2. Add all your Radarr and Sonarr instances with their respective API Keys.
3. Add a Cross-Seed URL if you want the "Upload Cmd" button to format commands for you.
4. Save the settings. 

*Note: All configuration data, including your Ignore List and API keys, are securely stored inside the `./data/` volume and persist across container restarts.*

## Matching Modes Comparison

qbit-vs-arr bietet verschiedene Strategien, um deine Medien mit den laufenden Torrents abzugleichen. Hier ist ein detaillierter Vergleich:

| Modus | Technik | Geschwindigkeit | Genauigkeit | Fehler-Risiko | Voraussetzung |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Hardlink (Inode)** | Dateisystem-ID | 🚀 Ultraschnell | 💎 100% | 0% | Lesezugriff auf Medien + Torrents. Hardlinks in *Arr aktiv. |
| **Fast Hash (Partial)** | Header/Footer Checksum | ⚡ Schnell | 🏆 99.9% | < 0.01% | Lesezugriff auf Medien + Torrents. |
| **Hybrid** | History-API + Name | 🟢 Schnell | ✅ Hoch | Niedrig | API-Zugriff auf *Arr Instanzen. |
| **Name Only** | String-Normalisierung | 🟢 Schnell | 🆗 Mittel | Mittel | Keine speziellen Anforderungen. |
| **Size Only** | Byte-Vergleich | 🟢 Schnell | ⚠️ Gering | Hoch | Keine speziellen Anforderungen. |

### Details zu den Modi

#### 🔗 Hardlink (Inode Match) — *Empfohlen*
Der Goldstandard für *Arr-Setups. Diese Methode prüft, ob die Mediendatei und die Torrent-Datei auf die exakt gleiche Stelle auf der Festplatte zeigen (dieselbe Inode). 
- **Vorteil:** Es wird kein einziges Byte der Datei gelesen. Der Check ist manipulationssicher.
- **Wann nutzen?** Immer, wenn Radarr/Sonarr Hardlinks verwenden (Standard) und beide Verzeichnisse auf derselben Partition liegen.

#### ⚡ Fast Hash (Partial Checksum)
Der Scanner liest jeweils das erste und das letzte Megabyte einer Datei und erstellt daraus einen eindeutigen Fingerabdruck.
- **Vorteil:** Erkennt identische Dateien auch dann, wenn sie **keine** Hardlinks sind (z. B. einfache Kopien).
- **Geschwindigkeit:** Muss Daten von der Festplatte lesen (~2MB pro Datei). Bei vielen Dateien kann I/O (Disk-Speed) zum Flaschenhals werden.

#### 🕒 Hybrid (History + Name)
Fragt zuerst die interne Historie von Radarr/Sonarr ab, um den exakten Release-Namen ("Grabbed Event") zu finden und gleicht diesen ab. Falls nichts gefunden wird, folgt ein normalisierter Namensvergleich.
- **Vorteil:** Sehr robust gegenüber Umbenennungen, solange die Historie in der Datenbank vorhanden ist.

#### 🏷️ Name Only / Size Only
Einfache Vergleichsmethoden. 
- **Name Only:** Normalisiert Dateinamen (entfernt Punkte, Leerzeichen, Group-Tags) und vergleicht sie.
- **Size Only:** Prüft nur die exakte Dateigröße bis auf das Byte genau. **Achtung:** Es gibt ein Risiko für "False Positives", wenn zwei verschiedene Releases zufällig exakt die gleiche Größe haben.

## Technologies
- **Frontend**: React, Vite
- **Backend**: Node.js, Express
- **Deployment**: Docker, Docker Compose

## License
MIT
