# ComfyUI Console — Setup Guide

A phone-installable PWA that talks to ComfyUI running on your own laptop,
reached securely over Tailscale.

## 1. Install Tailscale

- Laptop: https://tailscale.com/download
- Phone: install the Tailscale app from the App Store / Play Store
- Sign into the **same Tailscale account** on both devices

Once connected, your laptop has a stable address like:
`laptop-name.your-tailnet.ts.net`

Find it by running `tailscale status` on the laptop.

## 2. Start ComfyUI

On the laptop, launch ComfyUI so it listens on all interfaces (not just
localhost) — this is what makes it reachable over Tailscale:

```bash
python main.py --listen 0.0.0.0 --port 8188
```

Leave this running whenever you want to use the app. If you want it to
survive laptop sleep less often, adjust your laptop's sleep settings for
when it's plugged in.

## 3. Get HTTPS via Tailscale Serve

PWAs require HTTPS to be installable. Tailscale can provide this for free
with a real certificate on your tailnet domain:

```bash
# Expose the PWA frontend (once you're running its dev/preview server)
tailscale serve --bg --https=443 5173

# Expose ComfyUI's API on its own path or subdomain-style port
tailscale serve --bg --https=8443 8188
```

Check `tailscale serve status` to see the URLs it assigns. You'll get
something like `https://laptop-name.your-tailnet.ts.net`.

**Simplify by proxying both through one origin:** the cleanest setup is
to build the frontend as static files and have ComfyUI (or a tiny
reverse proxy like Caddy) serve them from the same origin as the API, so
you don't have to deal with cross-origin requests. If you'd rather keep
it simple for now, two separate `tailscale serve` HTTPS endpoints
(frontend + API) also works — just set `VITE_COMFY_URL` in the frontend
`.env` to the API's URL.

## 4. Fill in your workflow

Open `src/workflowTemplate.ts` and follow the instructions at the top:

1. In ComfyUI, enable Dev Mode (Settings → Enable Dev Mode Options)
2. Build/load your workflow, then **"Save (API Format)"**
3. Paste the exported JSON into `BASE_WORKFLOW`
4. Update the node ID references in `buildWorkflow()` to match your
   actual prompt/seed/etc. node IDs from that JSON

## 5. Install dependencies and run

```bash
npm install
npm run dev
```

Visit the Tailscale HTTPS URL from your phone's browser.

## 6. Install to homescreen

- **iOS Safari**: Share button → "Add to Home Screen"
- **Android Chrome**: menu (⋮) → "Add to Home Screen" / "Install app"

The app will launch full-screen, no browser chrome, like a native app.

## 7. Production build (optional, faster load)

Instead of running the dev server, build static files and serve those:

```bash
npm run build
# outputs to dist/ — serve this folder with any static file server,
# e.g. `npx serve dist` or point Caddy/nginx at it
```

## Troubleshooting

- **"Could not reach ComfyUI" in the app**: check `tailscale status` on
  both devices shows "connected", and that ComfyUI is still running
  with `--listen 0.0.0.0`
- **Custom nodes missing**: any custom nodes your workflow uses must be
  installed in ComfyUI's `custom_nodes/` folder on the laptop — the
  workflow JSON alone doesn't carry them
- **PWA won't install**: confirm you're accessing it via the HTTPS
  Tailscale URL, not plain `http://` — browsers require HTTPS (or
  `localhost`) for installability
