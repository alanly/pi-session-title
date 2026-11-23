# pi-session-title

A Pi 1.6.0 extension that names new sessions from the first prompt. Use
`/retitle` to name a session from the active conversation. The title model
does not change the active model or add to the conversation.

## Try it locally

Load this checkout's extension directly, without installing anything or
changing your global Pi configuration:

```bash
pi -e /Users/alan/src/github.com/alanly/pi-session-title/src/index.ts
```

To load the package on future runs, add the checkout to Pi's settings:

```bash
pi install /Users/alan/src/github.com/alanly/pi-session-title
```

Use either `pi install` or `-e`, not both.

## Settings

Session titling reads an optional `sessionTitle` object from Pi's settings.
Add it to `~/.pi/agent/settings.json`:

```json
{
  "sessionTitle": {
    "enabled": true,
    "provider": "anthropic",
    "modelId": "claude-haiku-4-5"
  }
}
```

- `provider` and `modelId` (required strings): the IDs as registered in Pi.
  The extension trims leading and trailing whitespace. It preserves case
  and internal characters such as `/`.
- `enabled` (optional boolean, default `true`): set to `false` to turn titling
  off without removing the configuration.

Pi merges user settings with settings from trusted projects. A trusted
project's `.pi/settings.json` can override individual title settings.

Use a built-in model or define a custom model in `~/.pi/agent/models.json`.
Missing, disabled, or invalid settings, or an unknown model, prevent title
requests. The extension does not fall back to the active model.

The title provider receives a bounded excerpt, which can still contain
sensitive text. Choose a provider that can receive this data. Pi handles
provider authentication; the extension does not read or store credentials.

Run `/reload` after editing `settings.json`. If you change `models.json`, open
`/model` to refresh the registry or restart Pi.

## Behavior

### Automatic naming

- The title request starts from the first processed user prompt, in parallel
  with the main request. Pi can save the title before the first reply arrives,
  but it does not wait for the title. One-shot runs such as `pi --print` can
  exit before the title is ready.
- The first user run is the only automatic opportunity: it is consumed even if
  it is ineligible or the title fails. Later prompts are not titled
  automatically.
- Naming is skipped silently whenever it cannot work: `sessionTitle` missing,
  disabled, or malformed; the configured model not found (there is never a
  fallback to your active model); no usable text in the prompt; the session
  already named (or its name cleared) or already containing conversation, such
  as a resumed session; the run started with `--no-session`; or generation
  failing, timing out, or being superseded.

### `/retitle`

`/retitle` renames the current session from its conversation so far:

- It is idle-only. While the agent is working you are asked to retry after the
  run finishes; no title request is made in the meantime.
- It titles from the active context as the agent itself sees it — current,
  compacted, and edited messages on the active branch — bounded to a
  fixed-size excerpt sent to the configured title model.
- It replaces the existing name and supersedes a still-pending automatic
  title, but never overrides a rename that happens while it generates (for
  example a manual `/name`): the later name action always wins.
- When it cannot produce a title — no usable conversation text, configuration
  unavailable, or generation failed — it keeps the current name and shows a
  short, generic reason. Provider details are never exposed, and cancellation
  is not treated as a failure.
- In print and JSON modes, the extension does not emit notices or add
  output. A successful rename is still saved.
- Runs started with `--no-session` keep no session file, so there is nothing
  lasting to name and nothing is saved.
