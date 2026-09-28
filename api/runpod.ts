const RUNPOD_BASE = 'https://api.runpod.ai/v2'
function send(res: any, status: number, body: unknown) { res.status(status).setHeader('Content-Type','application/json').send(JSON.stringify(body)) }
function config() {
  const apiKey = process.env.RUNPOD_API_KEY
  const endpointId = process.env.RUNPOD_ENDPOINT_ID
  if (!apiKey || !endpointId) throw new Error('RunPod is not configured. Set RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID.')
  return { apiKey, endpointId }
}
async function rp(path: string, init?: RequestInit) {
  const { apiKey, endpointId } = config()
  return fetch(`${RUNPOD_BASE}/${endpointId}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
}
export default async function handler(req: any, res: any) {
  try {
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
      if (body?.action === 'cancel' && body?.jobId) { const r = await rp(`/cancel/${encodeURIComponent(body.jobId)}`); const data = await r.json(); return send(res,r.ok?200:r.status,data) }
      if (!body?.workflow) return send(res,400,{error:'workflow is required'})
      const r = await rp('/run',{method:'POST',body:JSON.stringify({input:{workflow:body.workflow,images:Array.isArray(body.images)?body.images:[]}})})
      const data = await r.json()
      return send(res,r.ok?200:r.status,data)
    }
    if (req.method === 'GET') {
      const jobId = typeof req.query?.jobId === 'string' ? req.query.jobId : ''
      if (!jobId) return send(res,400,{error:'jobId is required'})
      const r = await rp(`/status/${encodeURIComponent(jobId)}`)
      const data = await r.json()
      return send(res,r.ok?200:r.status,data)
    }
    return send(res,405,{error:'Method not allowed'})
  } catch (e) { return send(res,500,{error:e instanceof Error?e.message:'RunPod proxy error'}) }
}
