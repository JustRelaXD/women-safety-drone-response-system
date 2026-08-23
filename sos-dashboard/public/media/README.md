# Local Incident Media

Put demo media under `incidents/<incident-id>/`:

```text
public/media/incidents/INC-2408/snapshot-001.jpg
public/media/incidents/INC-2406/recording-001.mp4
public/media/incidents/INC-2406/poster.jpg
```

These files are served locally by Vite at `/media/...` and are ignored by Git. The dashboard falls back to its built-in placeholder when a configured file is missing. Do not put sensitive media in GitHub.
