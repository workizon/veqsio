# hello-plugin

A tiny Veqsio plugin: it verifies the signature of every delivery, logs the event and serves one sidebar panel.

1. Run it somewhere reachable over https (for local trials set `PLUGINS_ALLOW_PRIVATE_HOSTS=true` on the Veqsio API, which also allows `http://localhost`): `SIGNING_SECRET=<secret> PORT=8787 bun server.ts`
2. Edit `baseUrl` in `manifest.json` to the public URL.
3. In Veqsio open Admin, Plugins, Install plugin, and enter `<baseUrl>/manifest.json`. The signing secret is shown once: restart the plugin with it.
4. Enable the plugin and approve `read:issues`.

See [`docs/plugins.md`](../../docs/plugins.md) for the full contract.
