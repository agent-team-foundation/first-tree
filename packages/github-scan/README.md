# `@first-tree/github-scan`

Internal runtime package for `first-tree github scan`.

It provides the GitHub notification scanner, local inbox, browser dashboard,
statusline bundle, and background daemon used by the umbrella CLI.

Use it through:

```bash
first-tree github scan --help
first-tree github scan install --allow-repo owner/repo
first-tree github scan status
```

Runtime state lives under `~/.first-tree/github-scan/` by default.
