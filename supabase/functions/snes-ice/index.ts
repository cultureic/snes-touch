// ICE servers for SNES Touch multiplayer (WebRTC): STUN always, plus TURN relays once configured.
// Set one of these as function secrets:
//   CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_KEY_API_TOKEN   Cloudflare Realtime TURN (short-lived credentials)
//   TURN_URLS (comma-separated) + TURN_USERNAME + TURN_CREDENTIAL   any static TURN server (coturn, Metered...)
// Deploy without JWT verification: the response is public apart from relay credentials,
// which only go to the game's own pages.
//   supabase functions deploy snes-ice --project-ref ckrxlqxkfxgagsghoegr --no-verify-jwt

type IceServer = { urls: string | string[]; username?: string; credential?: string }

const STUN: IceServer = { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }
const GAME_ORIGIN = /^https:\/\/snes-touch(-[a-z0-9-]+)?\.vercel\.app$|^http:\/\/localhost(:\d+)?$/
const TTL_SECONDS = 4 * 3600

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') ?? ''
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Content-Type': 'application/json',
    Vary: 'Origin',
  }
  if (req.method === 'OPTIONS') return new Response(null, { headers })
  const iceServers = [STUN]
  let turn = 'not for this origin'
  if (GAME_ORIGIN.test(origin)) {
    const relays = await turnServers()
    iceServers.push(...relays.servers)
    turn = relays.status
  }
  // `turn` says how the relay lookup went (never the credentials), so a missing relay can be
  // diagnosed; it's in the body because Supabase's gateway drops custom response headers
  return new Response(JSON.stringify({ iceServers, turn }), { headers })
})

async function turnServers(): Promise<{ servers: IceServer[]; status: string }> {
  const keyId = Deno.env.get('CLOUDFLARE_TURN_KEY_ID')
  const token = Deno.env.get('CLOUDFLARE_TURN_KEY_API_TOKEN')
  if (keyId && token) {
    try {
      const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TTL_SECONDS }),
      })
      if (!response.ok) {
        console.error('Cloudflare TURN credentials failed', response.status, await response.text())
        return { servers: [], status: `cloudflare error ${response.status}` }
      }
      const { iceServers } = (await response.json()) as { iceServers: IceServer[] }
      // keep the relay entries (STUN is already listed); browsers block port 53
      const servers = iceServers
        .filter((server) => server.username)
        .map((server) => ({ ...server, urls: [server.urls].flat().filter((url) => !/:53(\?|$)/.test(url)) }))
      return { servers, status: servers.length > 0 ? 'cloudflare' : 'cloudflare returned no relays' }
    } catch (error) {
      console.error('Cloudflare TURN request failed', error)
      return { servers: [], status: 'cloudflare unreachable' }
    }
  }
  const urls = Deno.env.get('TURN_URLS')
  if (urls) {
    const servers = [
      {
        urls: urls.split(',').map((url) => url.trim()),
        username: Deno.env.get('TURN_USERNAME'),
        credential: Deno.env.get('TURN_CREDENTIAL'),
      },
    ]
    return { servers, status: 'static' }
  }
  const partial = keyId ? 'CLOUDFLARE_TURN_KEY_API_TOKEN missing' : token ? 'CLOUDFLARE_TURN_KEY_ID missing' : 'no secrets set'
  return { servers: [], status: `not configured: ${partial}` }
}
