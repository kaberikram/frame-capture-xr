/** Talks to the depth worker. Safe to call before the first capture; later calls join the same load. */

export interface DepthField {
  width: number
  height: number
  data: Uint8Array
}

interface WorkerMsg {
  type: string
  id?: number
  message?: string
  width?: number
  height?: number
  data?: Uint8Array
}

let worker: Worker | null = null
let loading: Promise<void> | null = null
let ready = false
let nextId = 0
const failures = new Set<(error: Error) => void>()

function depthWorker(): Worker {
  if (worker) return worker
  const thread = new Worker(new URL('./depth-worker.ts', import.meta.url), { type: 'module' })
  thread.addEventListener('error', () => {
    if (worker === thread) worker = null
    thread.terminate()
    loading = null
    ready = false
    const pending = [...failures]
    failures.clear()
    for (const fail of pending) fail(new Error('depth worker failed'))
  })
  worker = thread
  return thread
}

export function prepareDepthModel(): Promise<void> {
  if (loading) return loading
  const thread = depthWorker()
  loading = new Promise((resolve, reject) => {
    const done = () => {
      thread.removeEventListener('message', onMessage)
      failures.delete(fail)
    }
    const fail = (error: Error) => {
      done()
      reject(error)
    }
    const onMessage = (event: MessageEvent<WorkerMsg>) => {
      if (event.data.id !== undefined) return
      if (event.data.type === 'ready') {
        done()
        ready = true
        resolve()
      } else if (event.data.type === 'error') {
        loading = null
        fail(new Error(event.data.message ?? 'depth model failed'))
      }
    }
    failures.add(fail)
    thread.addEventListener('message', onMessage)
    thread.postMessage({ type: 'prepare' })
  })
  return loading
}

export function estimateDepth(raster: { width: number; height: number; data: Uint8ClampedArray }): Promise<DepthField> {
  const width = raster.width
  const height = raster.height
  const data = new Uint8ClampedArray(raster.data)
  return prepareDepthModel().then(async () => {
    const thread = depthWorker()
    const id = ++nextId
    return new Promise<DepthField>((resolve, reject) => {
      const done = () => {
        thread.removeEventListener('message', onMessage)
        failures.delete(reject)
      }
      const onMessage = (event: MessageEvent<WorkerMsg>) => {
        const msg = event.data
        if (msg.id !== id) return
        if (msg.type === 'progress') return
        done()
        if (msg.type === 'depth' && msg.data && msg.width && msg.height) {
          resolve({ width: msg.width, height: msg.height, data: msg.data })
          return
        }
        reject(new Error(msg.message ?? 'depth failed'))
      }
      failures.add(reject)
      thread.addEventListener('message', onMessage)
      thread.postMessage({ type: 'estimate', id, width, height, data }, [data.buffer])
    })
  })
}
