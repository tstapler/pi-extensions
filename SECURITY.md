# Security

Pi extensions execute with the user's authority. Treat every new tool, hook,
subprocess, filesystem path, network destination, environment read, and
persistent file as security-sensitive.

This repository must not store or return credentials. Credential integrations
belong in separately reviewed providers that resolve values in the host process
and scope them to the smallest possible child process.

The compatibility package is not a sandbox. Pair it with the reviewed global
permission extension. Human-input tools fail in non-interactive modes rather
than inventing approval.

Report vulnerabilities privately through GitHub's security advisory interface.
Do not include real credentials, proprietary source, or session transcripts in
reports or fixtures.
