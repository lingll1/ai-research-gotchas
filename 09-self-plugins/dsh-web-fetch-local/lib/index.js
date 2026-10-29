// dsh-web-fetch-local — a minimal local WebFetchProvider for the web seam.
// Retrieves http(s) URLs with node's built-in fetch, with basic SSRF guards
// (blocks loopback / private / link-local addresses).

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export const name = 'dsh-web-fetch-local'
export const inject = ['web']

const MAX_BODY_CHARS = 200_000
const USER_AGENT = 'dsh-web-fetch-local/1.0'

function isPrivateIP(ip) {
  if (ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0' || ip === '::') return true
  if (ip.startsWith('10.')) return true
  if (ip.startsWith('192.168.')) return true
  if (ip.startsWith('169.254.')) return true
  if (ip.startsWith('127.')) return true
  if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true // IPv6 ULA / link-local
  const parts = ip.split('.')
  if (parts.length === 4) {
    const second = parseInt(parts[1], 10)
    if (parts[0] === '172' && second >= 16 && second <= 31) return true
  }
  return false
}

async function isBlockedHost(hostname) {
  const h = hostname.toLowerCase()
  if (h === 'localhost') return true
  if (isIP(hostname)) return isPrivateIP(hostname)
  try {
    const addrs = await lookup(hostname, { all: true })
    for (const a of addrs) {
      if (isPrivateIP(a.address)) return true
    }
  } catch {
    // resolution failure — let the fetch attempt fail naturally
  }
  return false
}

export function apply(ctx) {
  ctx.web.registerFetchProvider({
    id: 'local',
    available() {
      return true
    },
    async fetch(request, signal) {
      let url
      try {
        url = new URL(request.url)
      } catch {
        throw new Error(`web_fetch: invalid URL "${request.url}"`)
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`web_fetch: unsupported protocol "${url.protocol}" (only http/https)`)
      }
      if (await isBlockedHost(url.hostname)) {
        throw new Error(`web_fetch: refused (internal/private host "${url.hostname}")`)
      }

      const resp = await globalThis.fetch(request.url, {
        redirect: 'follow',
        signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,text/plain;q=0.9,*/*;q=0.5',
        },
      })

      const raw = await resp.text()
      const truncated = raw.length > MAX_BODY_CHARS
      const content = truncated ? raw.slice(0, MAX_BODY_CHARS) : raw
      const contentType = (resp.headers.get('content-type') || '').toLowerCase()
      const kind = contentType.includes('text/html') ? 'html' : 'text'

      return {
        url: resp.url || request.url,
        statusCode: resp.status,
        body: { kind, content },
        truncated,
      }
    },
  })
}
