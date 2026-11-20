# Anonymous usage statistics

Veqsio can tell the project that an installation exists, so we can see how many instances run and which versions are in use (and, for example, how many have not yet installed a security release). This page says exactly what is sent, when, and how to switch it off.

## What is sent

About once a day, one small JSON document:

```json
{ "v": 1, "id": "3f2b1c8e-5d4a-4b7e-9a10-2c6f8e1d7b55", "version": "1.4.2", "build": "20261119.1104",
  "edition": "team", "deploy": "docker", "users": "11-50" }
```

| Field | Meaning |
| --- | --- |
| `id` | A random identifier created on the first run. It identifies the installation and nothing else; it is not derived from the host, the domain or any person. |
| `version`, `build` | The Veqsio version and the build identifier. |
| `edition` | `community`, `team` or `enterprise` (from the licence key, if any). |
| `deploy` | `docker`, `kubernetes` or `other`. |
| `users` | A range, never the exact number: `1-10`, `11-50`, `51-200`, `201-1000`, `1000+`. |

**Not sent:** names, e-mail addresses, the host or domain name, IP addresses of your users, any issue, project or other content, licence keys, or anything else about the machine. The server that receives the report keeps one row per installation and day and does not store the sender's IP address.

You can see the exact content for your instance at any time, as an administrator, at `GET /rest/api/2/admin/telemetry`.

## When nothing is sent

- It is switched off: **Administration, Instance settings, Updates, "Share anonymous usage statistics"**, or the environment variable `VEQSIO_TELEMETRY=off` (which wins over the setting; it is passed to the containers by the Compose files). The installer writes it for you with `--no-telemetry`, and it prints this information at the end of every installation.
- This is a managed Veqsio Cloud workspace, the public demo, or a non-production run (`NODE_ENV` is not `production`).
- The first report is sent only ten minutes or more after the first start, so there is time to switch it off before anything leaves the server.
- The server has no internet access: the report simply fails quietly and the instance works as always.

## Where it goes

`https://cloud.veqsio.com/api/telemetry/ping` by default. `VEQSIO_TELEMETRY_URL` can point it at your own collector (https only), for example to count your own fleet.

## Why

Open-source software with no way to see its use is hard to look after. The numbers are only used to understand adoption and to decide how long old versions need to be supported. They are never sold or shared.
