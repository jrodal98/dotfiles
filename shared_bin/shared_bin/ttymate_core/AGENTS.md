# ttymate_core — portable LLM CLI

`~/shared_bin/ttymate` provides `ask` and `shell` over a stdlib-only LLM client. The built-in backend targets an OpenAI-compatible LiteLLM proxy.

## Layout

```
~/shared_bin/
  ttymate               # shell entrypoint
  ttymate_core/
    launcher.py         # optional ~/.config/ttymate discovery
    main.py             # injectable CLI and argument handling
    backends.py         # Backend, ResolvedBackend, LiteLLMBackend
    protocols.py        # Anthropic, OpenAI-compatible, and Gemini wire formats
    transport.py        # Transport and StandardTransport
    client.py           # buffered/SSE HTTP client
    engines.py          # ask identity and shell prompt/post-processing
    config.py           # portable defaults
    tests/              # launcher, backend, CLI, and transport tests
```

## Configuration hook

The launcher checks `${XDG_CONFIG_HOME:-~/.config}/ttymate/__init__.py`. If present, it loads the file as a package and calls `configure()` when that callable exists. The function may return these keyword options for `main()`:

- `extra_backends`
- `default_backend`
- `default_model`
- `sync_models_command`

An absent directory, absent `__init__.py`, or package without `configure` leaves portable defaults unchanged. Invalid hooks fail before processing a prompt.

## Boundaries

Keep deployment-specific endpoints, credentials, routing, and proxy policy outside this package.

- A `Protocol` owns URL paths, request bodies, protocol-required headers, and response/SSE parsing.
- A `Backend` resolves a user model into protocol, endpoints, wire model, token limit, extra headers, and transport.
- A `Transport` owns TLS, proxy, redirect, and opener policy.
- `Client` owns retries, HTTP error handling, and streaming mechanics.

## LiteLLM configuration

Backend/model precedence is command-line `--backend`/`--model`, then `TTYMATE_BACKEND`/`TTYMATE_MODEL`, then `litellm` and `gpt-5-nano`.

- `LITELLM_BASE_URL` defaults to `http://127.0.0.1:4000/v1`.
- `LITELLM_API_KEY` is optional. Authenticated plaintext connections are allowed only for loopback URLs.
- API keys belong in environment variables, not CLI arguments.

Global `--backend`, `--model`, and `--stream` options must also work after `ask` or `shell`. Keep `shell` on `nargs="*"`; `argparse.REMAINDER` swallows options.

## Client behavior

Streaming is the default. The SSE reader must use `HTTPResponse.read1(n)`: `read(n)` waits for the full buffer and destroys incremental output. Buffered and streaming requests retry fallback endpoints only for 429, 5xx, transport setup failures, and `OSError`. They fail fast on other 4xx responses. Transports reject redirects so credentials and connection policy remain bound to the configured origin. Once a stream yields output, a mid-stream failure ends rather than retrying and duplicating text.

Exit codes: usage/backend errors `2`, transport/runtime/configuration errors `1`, interrupt `130`, and closed output pipes `0` without a traceback.

## Development

```
black ~/shared_bin/ttymate_core/*.py ~/shared_bin/ttymate_core/tests/*.py
PYTHONPATH=~/shared_bin python3 -m unittest discover -s ~/shared_bin/ttymate_core/tests -v
~/shared_bin/ttymate --help
```
