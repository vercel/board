import type { ProfileOption } from '../client/client.ts'
import { CSS } from './style.ts'

// The inspector's page, before its script runs: what `vb inspect` serves on your machine, and what
// `@vercel/board/inspect` serves from a deployment.

const attribute = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

/** What only this page is told: its token for the proxy, the profile it starts as, where it's mounted, and whether it must name a profile. */
export type ShellOptions = { token: string; profile: ProfileOption; base: string; named: boolean }

export const shell = ({ token, profile, base, named }: ShellOptions) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="inspect-token" content="${attribute(token)}">
<meta name="inspect-profile" content="${attribute(JSON.stringify(profile))}">
<meta name="inspect-base" content="${attribute(base)}">
${named ? '<meta name="inspect-named" content="1">\n' : ''}<title>board</title>
<style>${CSS}</style>
</head>
<body>
<div id="root"></div>
<script type="module" src="${attribute(base)}/app.js"></script>
</body>
</html>`

export const CSP = [
  "default-src 'none'",
  // Attachments arrive as `blob:` URLs: the page fetches them through the proxy, with its token.
  'img-src https: http://localhost:* http://127.0.0.1:* data: blob:',
  'media-src blob:',
  "style-src 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')
