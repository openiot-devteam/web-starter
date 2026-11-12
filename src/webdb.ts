/**
 * 웹 퍼블리셔 데이터 도우미. 서버 없이 화면에서 글, 댓글, 신청서 같은 데이터와 사진, 문서 같은 파일을 저장하고 읽습니다.
 *
 *   import { collection, files } from './webdb'
 *
 *   const guestbook = collection('guestbook')
 *   await guestbook.add({ name: '홍길동', message: '안녕하세요' })
 *   const items = await guestbook.all()        // 최신순
 *
 *   const file = await files.upload(input.files[0])   // { id, name, size, url }
 *   img.src = files.url(file.id)
 *
 * 데이터와 파일은 웹 퍼블리셔 콘솔의 데이터베이스 칸에서 만든 DB에 들어갑니다(README 의 '데이터 저장').
 *   데이터 DB  이름 = DATA_DB (기본: 사이트 이름)          컬렉션도 그 DB 안에 만듭니다
 *   파일 DB    이름 = FILES_DB (기본: 사이트 이름-files)
 * 두 DB 모두 이 사이트에 연결해야 화면에서 쓸 수 있습니다.
 *
 * 배포된 사이트에서는 /api/sdk.js 를, 내 컴퓨터(npm run dev)에서는 배포된 사이트 주소의 sdk 를 불러옵니다.
 * 그래서 내 컴퓨터에서 데이터를 쓰려면 한 번은 배포해 두어야 합니다.
 */
import config from '../publisher.json'

/** 콘솔에서 만든 DB 이름. 다른 이름으로 만들었으면 여기만 바꿉니다. */
export const DATA_DB = config.site
export const FILES_DB = `${config.site}-files`

export type Doc<T> = T & { id: string; createdAt: string; updatedAt: string }

interface Collection<T> {
  add(data: T): Promise<Doc<T>>
  all(): Promise<Doc<T>[]>
  list(opts?: { limit?: number; order?: 'asc' | 'desc'; where?: Partial<T>; cursor?: string }): Promise<{ items: Doc<T>[]; nextCursor?: string }>
  get(id: string): Promise<Doc<T>>
  update(id: string, data: Partial<T>): Promise<Doc<T>>
  remove(id: string): Promise<void>
}

export type StoredFile = { id: string; name: string; size: number; contentType?: string; createdAt: string; path: string }

interface Files {
  upload(file: File, opts?: { name?: string }): Promise<StoredFile & { url: string }>
  all(): Promise<StoredFile[]>
  list(opts?: { limit?: number; cursor?: string }): Promise<{ items: StoredFile[]; nextCursor?: string }>
  url(id: string): string
  remove(id: string): Promise<void>
}

declare global {
  interface Window {
    webdb?: {
      db(name: string): { collection<T>(name: string): Collection<T> }
      files(name: string): Files
    }
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

/** 데이터 DB(DATA_DB) 안의 컬렉션. */
export function collection<T extends object>(name: string): Collection<T> {
  const c = () => sdk().then((w) => w.db(DATA_DB).collection<T>(name))
  return {
    add: (data) => c().then((x) => x.add(data)),
    all: () => c().then((x) => x.all()),
    list: (opts) => c().then((x) => x.list(opts)),
    get: (id) => c().then((x) => x.get(id)),
    update: (id, data) => c().then((x) => x.update(id, data)),
    remove: (id) => c().then((x) => x.remove(id)),
  }
}

const filesBase = () =>
  location.hostname.endsWith(SITES_DOMAIN) ? '/api/' : `https://${config.site}.${SITES_DOMAIN}/api/`

/** 파일 DB(FILES_DB). 이미지는 files.url(id) 를 <img src> 에 넣어 보여 줍니다. */
export const files: Files = {
  upload: (file, opts) => sdk().then((w) => w.files(FILES_DB).upload(file, opts)),
  all: () => sdk().then((w) => w.files(FILES_DB).all()),
  list: (opts) => sdk().then((w) => w.files(FILES_DB).list(opts)),
  url: (id) => `${filesBase()}files/${encodeURIComponent(FILES_DB)}/${encodeURIComponent(id)}`,
  remove: (id) => sdk().then((w) => w.files(FILES_DB).remove(id)),
}
