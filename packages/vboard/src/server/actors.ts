import type { ActorsState, Actor } from '../contract/reducers.ts'
import type { Author } from '../contract/schemas.ts'
import { extractMentions } from '../contract/mentions.ts'
import type { Principal } from './auth.ts'
import { badRequest } from './errors.ts'

/** Agents whose avatars the board serves itself. */
export const KNOWN_AGENTS = ['claude', 'codex', 'grok', 'pi'] as const

const PROFILE = /^[A-Za-z][A-Za-z0-9-]{0,31}$/
const HANDLE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/

export type ResolvedActor = {
  author: Author
  actor: Actor
}

/** The actor a request writes as: its principal, plus the profile it selects. */
export function resolveActor(
  principal: Principal,
  headers: Headers,
  boardUrl: string,
): ResolvedActor {
  const profileName = headers.get('x-board-profile')?.trim() || null
  if (profileName !== null && !PROFILE.test(profileName))
    throw badRequest(
      'profile names start with a letter and use up to 32 letters, numbers, and hyphens',
    )
  const avatarHeader = headers.get('x-board-avatar')?.trim() || null
  if (avatarHeader !== null && !isAvatarUrl(avatarHeader))
    throw badRequest('avatars must be https URLs (http only on localhost)')
  const session = headers.get('x-board-session')?.trim().slice(0, 200) || null

  let baseHandle = principal.handle
  let personName: string | null = null
  if (principal.kind === 'person') {
    const sent = headers.get('x-board-handle')?.trim().toLowerCase()
    if (sent) {
      if (!HANDLE.test(sent)) throw badRequest(`invalid handle: ${sent}`)
      baseHandle = sent
    }
    // A display name, URI-encoded so any language fits in a header.
    const name = headers.get('x-board-name')
    if (name) {
      try {
        personName = decodeURIComponent(name).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 128) || null
      } catch {
        throw badRequest('x-board-name must be URI-encoded')
      }
    }
  }

  const profile = profileName?.toLowerCase() ?? null
  const id = profile === null ? principal.id : `${principal.id}+${profile}`
  const known = profile !== null && (KNOWN_AGENTS as readonly string[]).includes(profile)
  const actor: Actor = {
    id,
    kind: profile === null ? principal.kind : 'agent',
    handle: profile === null ? baseHandle : `${baseHandle}/${profile}`,
    name: profileName ?? personName ?? baseHandle,
    avatar: avatarHeader ?? (known ? `${boardUrl}/avatars/${profile}` : null),
  }
  return {
    author: { actor: id, principal: principal.id, profile, session },
    actor,
  }
}

function isAvatarUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
    )
  } catch {
    return false
  }
}

/** An `actor.seen` event, or null when the board already knows these details. */
export function actorSeen(seen: Actor, known: ActorsState) {
  const existing = known.byId[seen.id]
  // Platforms don't always send an avatar (GitHub comments via Chat SDK omit it,
  // its webhooks include it): a missing one keeps the avatar the board knows.
  const actor = seen.kind === 'external' && seen.avatar === null ? { ...seen, avatar: existing?.avatar ?? null } : seen
  if (
    existing &&
    existing.kind === actor.kind &&
    existing.handle === actor.handle &&
    existing.name === actor.name &&
    existing.avatar === actor.avatar
  )
    return null
  return {
    type: 'actor.seen' as const,
    payload: {
      actor: actor.id,
      kind: actor.kind,
      handle: actor.handle,
      name: actor.name,
      avatar: actor.avatar,
    },
  }
}

/**
 * Resolves prose mentions to actor IDs. Each `@handle` must name exactly one
 * actor the board has seen; `@[actor-id]` names one directly. `lenient` is for
 * platform text: a mention that doesn't resolve stays plain text, and the rest
 * still count. Without `candidates`, an ambiguous mention doesn't list who it
 * could be: a caller that can't read every channel can't list actors either.
 */
export function resolveMentions(
  text: string,
  known: ActorsState,
  pending?: Actor,
  lenient = false,
  candidates = true,
): string[] {
  const resolved: string[] = []
  const add = (id: string) => {
    if (!resolved.includes(id)) resolved.push(id)
  }
  const fail = (error: Error) => {
    if (!lenient) throw error
  }
  for (const token of extractMentions(text)) {
    if (token.kind === 'actor') {
      if (known.byId[token.actor] || pending?.id === token.actor) add(token.actor)
      else fail(badRequest(`unknown actor @[${token.actor}]`, 'unknown_mention'))
      continue
    }
    const ids = new Set(known.byHandle[token.handle] ?? [])
    if (pending && pending.handle.toLowerCase() === token.handle) ids.add(pending.id)
    if (ids.size === 1) add([...ids][0]!)
    else if (ids.size === 0) fail(badRequest(`unknown mention @${token.handle}`, 'unknown_mention'))
    else if (!candidates) fail(badRequest(`ambiguous mention @${token.handle}: use @[actor-id]`, 'ambiguous_mention'))
    else {
      const options = [...ids]
        .map((id) => `@[${id}] (${known.byId[id]?.name ?? pending?.name ?? id})`)
        .join(' or ')
      fail(badRequest(`ambiguous mention @${token.handle}: use ${options}`, 'ambiguous_mention'))
    }
  }
  return resolved
}
