# Contributing

## Setup

There is nothing to install. You need Node.js 22.18 or newer, which runs TypeScript directly.

```sh
npm test
```

CI runs the same command on Node.js 22 and 24.

To try your changes in OMP, point it at your checkout:

```sh
omp install ./path/to/kiro-for-omp
```

That links the folder instead of copying it. Restart OMP after each change.

## Pull requests

- Keep each pull request to one change, and add a test for any behavior you change.
- Tests run offline. Do not add tests that call Kiro.
- The extension has no dependencies. Use Node.js built-ins only.
- Never commit credentials, kiro-cli databases or session logs, even in fixtures.
