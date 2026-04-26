# Resume Optimizer

An AI-powered resume optimizer built with Next.js + Tailwind CSS + Claude API.

## Features
- Paste your resume and a job description
- Get an instant ATS match score (0–100)
- See your strengths and skill gaps
- Receive actionable optimization suggestions
- Get an AI-rewritten professional summary tailored to the job

## Setup

```bash
npm install
```

Create a `.env.local` file:
```
ANTHROPIC_API_KEY=your_key_here
```

Run locally:
```bash
npm run dev
```

## Deploy on Vercel
Add `ANTHROPIC_API_KEY` as an environment variable in your Vercel project settings.
