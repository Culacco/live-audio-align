# Security policy

Only the latest source/release is maintained. This is an experimental local
browser extension, not a security-reviewed or accuracy-certified product.

## Reporting

For a vulnerability, use GitHub's private vulnerability reporting if the
repository's Security tab offers it. Otherwise open an issue containing only
a minimal, non-sensitive description and request a private reporting channel.
Do not post credentials, private stream URLs, audio recordings or working
exploits that expose someone else's data in public issues.

## Boundaries

- No remote code, runtime third-party libraries, backend or native service.
- CSP restricts extension scripts to local files and disallows external connections.
- Capture is explicitly initiated by the user; role adapters allow only three HTTPS hosts.
- Internal message handlers verify the extension sender and distinguish popup,
  worker and offscreen commands. Content-script senders cannot issue capture commands.
- No `externally_connectable` or `web_accessible_resources` exposure.
- Captured audio includes all audio within the selected tab; avoid sensitive content.
- Resource cleanup is tested with mocked APIs. Browser bugs, permissions,
  protected streams and OS-level failures remain outside the extension's control.

Use the Stop button before leaving a session. If stopping reports an error,
disable the extension in the browser's extension manager. Keep your browser
updated and inspect code changes before loading an unpacked extension.
