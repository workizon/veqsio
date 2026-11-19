# Configuration as code

Administration → Instance settings → **Configuration as code**, or the API:

```bash
curl -b cookies -o veqsio-config.json https://your-host/rest/api/2/admin/config/export
curl -b cookies -X POST -H 'Content-Type: application/json' --data @veqsio-config.json 'https://your-host/rest/api/2/admin/config/import?dryRun=true'
```

The document (`version: 1`) holds instance settings, switched-off features and, per project key: public flag, switched-off project features, components and versions. Importing:
- validates everything first and applies **nothing** when there is an error;
- `?dryRun=true` (and the UI preview) lists the changes without applying;
- is idempotent: components and versions are matched by name and only added, nothing is deleted or renamed;
- skips projects that do not exist (with a warning) and refuses to make a service desk project public.

Needs the System Administrator permission. The format is JSON; YAML is not supported yet. Not covered: workflows, schemes, custom fields, boards, roles and permission schemes.
