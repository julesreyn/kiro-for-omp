# Security

## Reporting a vulnerability

Report it privately through
[GitHub's vulnerability reporting](https://github.com/julesreyn/kiro-for-omp/security/advisories/new),
not in a public issue. Leave out real tokens, API keys and private prompts.

## What the extension touches

- It reads your Kiro login from the kiro-cli database, the Kiro IDE token cache, OMP's credential
  store or `KIRO_API_KEY`, and sends it only to Kiro and AWS sign-in endpoints.
- Tokens are stored in OMP's own credential store. The sign-in method, region, Kiro profile and,
  for organization logins, the OIDC client registration go to `~/.omp/agent/kiro-auth-meta.json`,
  readable only by you.
- It has no runtime or install-time dependencies, and no install scripts.
