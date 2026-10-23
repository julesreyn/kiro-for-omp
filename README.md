# kiro-for-omp

Use the models in your Kiro account (Claude, GPT, Kimi, GLM and others) from
[OMP](https://github.com/can1357/oh-my-pi).

If `kiro-cli` is already signed in, there is nothing to configure: the extension reuses that login
and lets `kiro-cli` keep it fresh. It works on macOS and Linux, with GitHub, Google, AWS Builder ID
and organization (IAM Identity Center) accounts, or a Kiro API key. It has no dependencies.

> Unofficial. Not affiliated with Kiro, Amazon, AWS or OMP.
> Based on [rabesss/omp-kiro-provider](https://github.com/rabesss/omp-kiro-provider).

## Install

```sh
omp install kiro-for-omp
```

Restart OMP, then check that your models are listed:

```sh
omp models kiro
```

Nothing listed? You are not signed in yet: see [Sign in](#sign-in).

To update, run `omp install kiro-for-omp@latest`, then restart OMP.

## Sign in

In OMP, run `/login`, choose **Kiro**, then pick a method:

| Option | When to use it |
| --- | --- |
| **1 · Reuse existing login** | You use `kiro-cli` or the Kiro IDE. Recommended. |
| **2 · API key** | You have a `ksk_…` key. |
| **3 · Refresh token** | You have a Kiro refresh token. |
| **4 · AWS Builder ID** | Personal AWS Builder ID, signed in through the browser. |
| **5 · Your organization** | IAM Identity Center. Enter your start URL (`https://your-org.awsapps.com/start`) and its AWS region (blank means `us-east-1`). |

Not signed in to anything yet? Run `kiro-cli login`, then choose option **1**.

To use an API key without `/login`, put it in `~/.omp/agent/.env`:

```sh
printf '%s\n' 'KIRO_API_KEY=ksk_...' >> ~/.omp/agent/.env && chmod 600 ~/.omp/agent/.env
```

Requests always use the account you chose in `/login`, even when `kiro-cli` is signed in to another
one.

## Use

```sh
omp --model kiro/auto
omp -p --model kiro/claude-opus-5-5 --thinking max "Review this diff"
```

- Any id from `omp models kiro` works in place of `auto`. Use `--model kiro/<id>`, not
  `--provider kiro`.
- `--thinking` sets the model's effort. `omp models kiro` lists the levels each model accepts:
  recent Claude, GPT and Kimi models use Kiro's own levels, up to `max`.
- `/usage` (or `omp usage`) shows your remaining Kiro credits.

The model may introduce itself as "Kiro". Kiro's servers add their own system prompt, and recent
models follow it over OMP's. You are still talking to the model you selected.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `omp models kiro` lists nothing | Sign in with `/login`, then run `omp models refresh kiro`. |
| `No API key found for kiro` | Your session expired. Run `kiro-cli whoami` (or `kiro-cli login`), then `/login` → **1**. |
| An update has no effect | Quit every `omp` session and run `rm ~/.omp/cache/legacy-pi-extension-cache.db*`. |
| Sessions wait on each other | Only one Kiro response streams at a time, to avoid throttling. Set `OMP_KIRO_STREAM_GATE=0` to allow parallel streams. |
| Wrong region or profile | Set `KIRO_REGION` (default `us-east-1`) or `KIRO_PROFILE_ARN`. |

## How it works

<details>
<summary>Authentication</summary>

Credentials are looked up in this order:

1. **kiro-cli**: `~/.local/share/kiro-cli/data.sqlite3` on Linux,
   `~/Library/Application Support/kiro-cli/data.sqlite3` on macOS, or the `amazon-q` equivalents.
   When its token expires, the extension asks `kiro-cli whoami` to renew it, so `kiro-cli` stays
   signed in.
2. **Kiro IDE**: `~/.aws/sso/cache/kiro-auth-token*.json`.
3. **API key**: from `/login` or `KIRO_API_KEY`.
4. **Device-code login** (Builder ID or organization) through `/login`.

The kiro-cli database is read with the SQLite built into the runtime (`node:sqlite` or
`bun:sqlite`); the `sqlite3` command is only a fallback.

</details>

<details>
<summary>Models</summary>

The model list is your account's live Kiro catalog. New and retired models show up without an
update to the extension. OMP caches the catalog and refreshes it daily, after `/login`, and on
`omp models refresh kiro`.

`models.json` only fills in what the catalog leaves out, such as readable names and image support.

</details>

<details>
<summary>Regions and profiles</summary>

- `KIRO_REGION` selects the API region (default `us-east-1`).
- The profile comes from `KIRO_PROFILE_ARN`, then the one saved at login, then the first profile
  Kiro lists for the account.
- Requests go to the region of the profile.
- `KIRO_API_BASE` overrides the inference URL.

</details>

<details>
<summary>Streaming</summary>

- Responses are AWS Event Stream frames, checked against their checksums.
- Capacity errors, empty responses and server errors are retried, but only before any output has
  been shown.
- When a session exits mid-response, the next one can stream immediately.

</details>

## Development

Requires Node.js 22.18 or newer, which runs TypeScript directly. There is nothing to install.

```sh
npm test
omp install .   # links this checkout into OMP
```

```text
index.ts                 extension entry point
models.json              metadata the live catalog leaves out
src/core.ts              requests, streaming, retries
src/converters.ts        OMP ↔ Kiro message and tool conversion
src/eventstream.ts       AWS Event Stream decoder
src/oauth.ts             /login, kiro-cli and IDE login reuse
src/auth/                device-code flow, token refresh
src/dynamic-models.ts    live model catalog
src/usage.ts             credits for /usage
tests/                   offline tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
