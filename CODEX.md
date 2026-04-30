# Codex Project Instructions

## Operating Mode

- Use plan mode before non-trivial work: tasks with 3 or more steps, architectural choices, billing or data changes, deployment changes, or unclear scope.
- For simple one-step fixes, act directly and keep the change narrow.
- If implementation goes sideways, stop, reassess, and write a revised plan before continuing.

## No Subagents

- Do not use subagents in this project.
- Keep exploration and implementation in the main agent context unless the user explicitly changes this rule.

## Project Stack

- App: Next.js.
- Database and backend services: Supabase.
- Hosting and deployments: Vercel.
- Payments: Stripe.
- Repo hosting: GitHub.
- External platform operations must go through Composio for GitHub, Vercel, Supabase, Stripe, and related services. Do not use direct platform CLIs or ad hoc APIs for those operations unless the user explicitly overrides this rule.

## Lessons Loop

- Maintain recurring corrections in `.codex/lessons.md`.
- At the start of meaningful work, review relevant lessons before editing.
- After a correction, add a short rule describing the mistake pattern and how to prevent it next time.

## Verification Standard

- Do not mark work complete without evidence.
- Run relevant tests, builds, type checks, lint checks, or focused scripts when available.
- For deployed or platform-dependent behavior, use Composio-backed checks where appropriate.
- Summarize what was verified and what could not be verified.

## Engineering Taste

- For non-trivial changes, pause before implementation and ask whether there is a simpler, cleaner design.
- Prefer maintainable solutions over brittle patches when the better design is clear.
- Keep scope tight and avoid unrelated refactors.
