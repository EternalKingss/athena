# Security Policy

Athena v4 is under active rebuild. Security-sensitive behavior is specified in `v4/SEMANTICS.md` and should be implemented with tests before it is considered complete.

## Security Model

Athena is a portable local agent. The v4 design assumes every host machine is a guest environment and keeps Athena's persistent state on her own drive.

Required properties:

- local server binds only to loopback
- every client must present a per-boot session token
- Host and Origin checks protect against DNS rebinding and browser cross-origin drive-by access
- risk classification is deterministic and fails closed
- Tier 2 actions require explicit approval
- unverified skills require a trust-chain gate
- background agents cannot pass Tier 2 gates
- provider failover and errors are visible, not silent
- raw host identifiers are not stored in plaintext

## Reporting A Vulnerability

Please do not open a public issue for vulnerabilities.

Email: forcepack6@gmail.com

Include:

- description of the vulnerability
- steps to reproduce
- potential impact
- suggested fix, if known

## Current Status

The v4 scaffold is not yet a production runtime. During the rebuild, security PRs should include tests that pin the relevant behavior in CI.
