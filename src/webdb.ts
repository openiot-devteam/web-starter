/**
 * 웹 퍼블리셔 데이터 도우미. 서버 없이 화면에서 글, 댓글, 신청서 같은 데이터를 저장하고 읽습니다.
 *
 *   import { collection } from './webdb'
 *   const guestbook = collection('guestbook')
 *   await guestbook.add({ name: '홍길동', message: '안녕하세요' })
 *   const items = await guestbook.all()        // 최신순
 *
 * 쓸 컬렉션은 publisher.json 의 collections 에 먼저 적어야 합니다(배포할 때 만들어집니다).
 * 배포된 사이트에서는 /api/sdk.js 를, 내 컴퓨터(npm run dev)에서는 배포된 사이트 주소의 sdk 를 불러옵니다.
 * 그래서 내 컴퓨터에서 데이터를 쓰려면 한 번은 배포해 두어야 합니다.
 */
import config from '../publisher.json'

export type Doc<T> = T & { id: string; createdAt: string; updatedAt: string }

interface Collection<T> {
  add(data: T): Promise<Doc<T>>
  all(): Promise<Doc<T>[]>
  list(opts?: { limit?: number; order?: 'asc' | 'desc'; where?: Partial<T>; cursor?: string }): Promise<{ items: Doc<T>[]; nextCursor?: string }>
  get(id: string): Promise<Doc<T>>
  update(id: string, data: Partial<T>): Promise<Doc<T>>
  remove(id: string): Promise<void>
}

declare global {
  interface Window {
    webdb?: { collection<T>(name: string): Collection<T> }
  }
}

const SITES_DOMAIN = 'sites.openiot.app'
let loading: Promise<NonNullable<Window['webdb']>> | null = null

function sdk() {
  if (window.webdb) return Promise.resolve(window.webdb)
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = location.hostname.endsWith(SITES_DOMAIN) ? '/api/sdk.js' : `https://${config.site}.${SITES_DOMAIN}/api/sdk.js`
    s.onload = () => (window.webdb ? resolve(window.webdb) : reject(new Error('webdb 를 불러오지 못했습니다')))
    s.onerror = () => reject(new Error('webdb 를 불러오지 못했습니다. 사이트를 한 번 배포했는지 확인해 주세요.'))
    document.head.append(s)
  })
  return loading
}

export function collection<T extends object>(name: string): Collection<T> {
  const c = () => sdk().then((w) => w.collection<T>(name))
  return {
    add: (data) => c().then((x) => x.add(data)),
    all: () => c().then((x) => x.all()),
    list: (opts) => c().then((x) => x.list(opts)),
    get: (id) => c().then((x) => x.get(id)),
    update: (id, data) => c().then((x) => x.update(id, data)),
    remove: (id) => c().then((x) => x.remove(id)),
  }
}
