# Blitz Legends — Multiplayer starter project

This project bundles the `blitz-legends.html` you provided with a Node.js HTTP + WebSocket server. The HTML already contains the online menu/client; the server is the missing piece that lets different browsers connect.

## Run locally

1. Install Node.js 20 or newer.
2. Open a terminal in this folder.
3. Run `npm install`
4. Run `npm start`
5. Open `http://localhost:8787` in your browser.

For two local test windows, open the same URL in two separate browser profiles. To play across different Wi-Fi networks, deploy this folder to a Node.js host that supports persistent WebSockets and persistent disk storage, then set `SERVER_URL` in the HTML to the deployed HTTPS origin if you keep the game page on Google Sites. If the deployed server serves the HTML itself, leave `SERVER_URL: ''`.

## Important deployment notes

- Google Sites is a page/embed host, not the multiplayer server. The Node server must be deployed separately for online play across networks.
- The server stores account data in `data/blitz-data.json`. Choose hosting with persistent storage; otherwise accounts and saves may disappear on restart/redeploy.
- Set `ALLOWED_ORIGIN` to your actual game page origin in production instead of leaving the default wildcard. Keep `DATA_DIR` on a persistent volume.
- This is a starter implementation. Core account registration/login, password hashing, recovery codes, cloud saves, private room codes, public lobbies, ready/start flow, and gameplay relay are implemented. Friend requests/invites, robust abuse prevention, production-grade database backups, and independent anti-cheat score verification are not complete. Do not treat online match records as verified competitive results.
- Use a unique password for this game; never reuse a personal/email password. Save the one-time recovery code somewhere private and never share it.

## Deploying the HTML on Google Sites

1. Deploy this Node project first and confirm `https://YOUR-SERVER/api/health` returns JSON with `"service":"blitz-legends"`.
2. In `blitz-legends.html`, change `SERVER_URL: ''` to `SERVER_URL: 'https://YOUR-SERVER'` (no trailing slash).
3. Upload/embed the updated HTML in your existing site workflow. The game server must allow the website's origin through `ALLOWED_ORIGIN`.
4. Test registration and a private room using two separate devices, ideally one on mobile data and one on Wi-Fi.

This package has not been deployed to a public host, so cross-network multiplayer will not work until you deploy and configure it.
