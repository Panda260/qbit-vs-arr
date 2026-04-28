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

## Technologies
- **Frontend**: React, Vite
- **Backend**: Node.js, Express
- **Deployment**: Docker, Docker Compose

## License
MIT
