# Security Policy

## Supported Versions

This project is under active development. Only the latest state of the `main`
branch is supported and receives security fixes.

## Reporting a Vulnerability

Please report security issues **privately** — do not open a public issue.

- Preferred: use GitHub's private vulnerability reporting for this repository:
  [Report a vulnerability](https://github.com/kbrAkg/voice-live-avatar/security/advisories/new)
- Include a clear description, reproduction steps, and potential impact.

You can expect an initial acknowledgement within a few days. Once a fix is
prepared, a coordinated disclosure will be arranged.

## Scope & Hardening Notes

- The application uses **keyless (Microsoft Entra ID / Managed Identity)**
  authentication. Do not commit secrets, keys, or connection strings.
- Real secrets belong only in a local, git-ignored `.env` file (see
  `.env.example`). Never place real values in `.env.example`.
- Secret scanning and push protection are enabled on this repository; pushes
  containing detected secrets will be blocked.
