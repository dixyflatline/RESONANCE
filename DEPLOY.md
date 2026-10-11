# Deploying RESONANCE PoC online

The app is one Node server that holds WebSocket connections open, so it needs a host that runs a long-lived process. Vercel can't, but Railway and Render both can, and the server runs there unchanged.

Once it's deployed:

- **Audience:** `https://<your-app>/`. Phones can join from any network, not just the venue Wi-Fi.
- **Engine:** `https://<your-app>/engine?key=<ENGINE_KEY>`. Open it on the laptop connected to the PA. The audio still plays in that browser tab.

## Before you deploy: set an engine key

The URL is public, so set the environment variable `ENGINE_KEY` to a secret of your choice.

- Only a browser that has the key can run the engine. Otherwise a stranger could open `/engine` and take over the audio.
- Sensor bridges also need the key: `?key=` on the WebSocket, or an `x-engine-key` header for `POST /api/input`.
- Audience phones don't need the key. They can only switch stems on and off and move the XY pads.

Make sure `packs/field-recordings-cc0/` contains the four `cc0_*.wav` files (run `npm run fetch-stems` first). They're uploaded with the app.

## Option A: Railway (CLI, no GitHub needed)

```bash
npm i -g @railway/cli
railway login                 # opens the browser
railway init                  # create a project (name it e.g. resonance-poc)
railway up                    # uploads this folder and deploys (node_modules is skipped)
railway variables --set "ENGINE_KEY=pick-a-long-secret"
railway domain                # creates the public https URL
```

To redeploy after changes, run `railway up` again. Pricing: a one-time $5 trial credit, then either a Free plan (0.5 GB RAM, enough for this) or Hobby at $5/month. The service doesn't sleep.

## Option B: Render (free, via GitHub)

1. Push this folder to a GitHub repo, including `packs/**/*.wav`; `.gitignore` already excludes `node_modules`.
2. In Render, choose **New → Blueprint** and pick the repo. `render.yaml` sets everything up, including a random `ENGINE_KEY`. You'll find the key under the service's **Environment** tab.
3. Open the `https://….onrender.com` URL.

The free plan sleeps after 15 minutes without traffic, and waking up takes about a minute. Connected phones and the engine keep it awake during a show. Before a performance, open the page a couple of minutes early.

## Notes

- **Timing:** the musical timing is still decided in the engine tab, so network lag only affects how quickly a tap reaches the engine. A tap still lands on the next beat.
- **Restarts:** on a restart or redeploy, the server forgets which stems were on and where the XY pads were.
- **Local shows:** local use works as before (`npm start`, no key needed).
