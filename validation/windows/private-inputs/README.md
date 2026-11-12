# Private Windows validation inputs

Stage only the byte-identical task-owned `motion-owner-video.mp4` copy here for
the focused owner-video scenarios. Verify it against `../motion-owner-video.json`.
Keep this dedicated directory free of unrelated files; the controller packages
the declared directory as a private validation asset. Media is ignored and must
never be committed, placed under `public/`, or published.

The tracked directory exists in ordinary checkouts without the private media.
The default full profile does not require the owner-provided file. A focused
owner scenario validates that the staged file exists, has the frozen byte count
and digest before starting conversion. A controller plan checks the containing
directory; its presence alone does not qualify the private file.
