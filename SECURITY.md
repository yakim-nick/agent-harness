# Security

This project runs an AI model with tools that can read (and, with approval, write) files. Please
read the threat notes in the README before pointing it at anything sensitive.

**Reporting a vulnerability:** please open a private security advisory on GitHub
("Report a vulnerability" on the Security tab) instead of a public issue.

Things worth reporting: a way to make a tool read or write outside the workspace, to bypass the
approval policy, to read `.git` or `.env*` files, or to leak the API key into a trace.
