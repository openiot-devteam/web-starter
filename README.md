# 웹 스타터

만든 웹사이트를 [웹 퍼블리셔](https://main.d28ughqycr4y1p.amplifyapp.com)로 바로 인터넷에 올리는 시작 저장소입니다.
명령 한 줄(`npm run deploy`)이면 `https://<사이트이름>.sites.openiot.app` 주소가 생깁니다.
서버, 데이터베이스, 보안, 트래픽 걱정 없이 화면만 만들면 됩니다.

## 사람이 하는 일

1. [웹 퍼블리셔](https://main.d28ughqycr4y1p.amplifyapp.com)에 가입하고 **API 키 만들기**를 누릅니다. 키는 그때 한 번만 보입니다.
2. 아래 프롬프트에 키를 붙여 넣어 클로드 코드에게 줍니다. 기획 폴더에 만들고 싶은 서비스를 적어 두면 그대로 만들어 올립니다.

```
기획 폴더에 적어 둔 서비스 설명대로 웹사이트를 만들어서 인터넷에 올려 주세요.

1. 개발 폴더에 https://github.com/openiot-devteam/web-starter 를 받아서 시작합니다.
   안내서(README)를 먼저 읽고 그대로 따릅니다.
2. 기획 폴더의 문서, 참고 링크, 디자인 캡처를 모두 읽고 화면을 만듭니다.
   - 처음 온 사람도 바로 쓸 수 있고, 휴대폰에서도 잘 보이게 만들어 주세요.
   - 글, 댓글, 신청서처럼 저장할 데이터는 스타터의 webdb 로 저장합니다. 서버는 따로 만들지 않습니다.
3. 개발 폴더의 .env 파일에 아래 한 줄을 넣습니다. 이 파일은 깃허브에 올리지 않습니다.
   PUBLISHER_API_KEY=여기에_받은_키를_붙여넣기
4. publisher.json 의 site 를 서비스에 어울리는 영어 이름으로 바꾸고 npm run deploy 로 배포합니다.
5. 배포가 끝나면 주소를 알려 주세요. 오류가 나면 고쳐서 다시 배포합니다.
```

## 클로드 코드가 따를 규칙

### 만드는 법

- Vite + React + TypeScript + Tailwind CSS 가 준비되어 있습니다. `src/App.tsx` 부터 바꿔 나갑니다.
- `npm install` 다음 `npm run dev` 로 내 컴퓨터에서 미리 봅니다.
- **정적 사이트만 됩니다.** 서버 코드(Next.js SSR, API 라우트, Express 같은 것)는 돌지 않습니다. 화면에서 하는 일은 모두 브라우저에서 끝나야 합니다.
- 여러 화면이 필요하면 react-router 같은 화면 쪽 라우터를 씁니다. `publisher.json` 의 `spa` 가 `true` 라 어느 주소로 들어와도 `index.html` 이 열립니다.
- 사진, 아이콘 같은 파일은 `public/` 에 두고 주소로 씁니다.

### 데이터 저장 (webdb)

글, 댓글, 신청서, 투표처럼 방문자가 남기는 데이터는 `src/webdb.ts` 로 저장합니다.

1. `publisher.json` 의 `collections` 에 이름과 종류를 적습니다. 배포할 때 만들어집니다.

   | 종류 | 누구나 할 수 있는 것 | 쓰임 |
   |---|---|---|
   | `guestbook` | 읽기, 쓰기 | 방명록, 댓글, 후기, 게시글 |
   | `form` | 쓰기 (읽기는 주인만) | 문의, 신청서, 설문. 받은 내용은 웹 퍼블리셔 대시보드에서 봅니다 |
   | `board` | 읽기 (쓰기는 주인만) | 공지, 메뉴판, 일정 |
   | `poll` | 읽기, 쓰기, 고치기 | 투표, 좋아요 수 |
   | `private` | 없음 | 주인만 쓰는 메모 |

2. 화면에서 이렇게 씁니다.

   ```ts
   import { collection } from './webdb'

   const posts = collection<{ title: string; body: string }>('posts')
   await posts.add({ title: '첫 글', body: '안녕하세요' })
   const items = await posts.all()            // 최신순
   const page = await posts.list({ limit: 20 }) // { items, nextCursor }
   ```

- 문서 하나는 16KB, 컬렉션 하나에 1만 개까지입니다. 방문자 한 명이 분당 30번까지 쓸 수 있습니다.
- 사진, 영상 같은 큰 파일은 저장할 수 없습니다. 파일은 `public/` 에 넣거나 외부 주소(유튜브 링크 등)만 저장합니다.
- 누구나 읽을 수 있는 컬렉션에는 전화번호, 이메일 같은 개인정보를 넣지 않습니다. 문의는 `form` 으로 받습니다.
- 내 컴퓨터(`npm run dev`)에서도 데이터는 배포된 사이트 것을 씁니다. 그래서 컬렉션을 추가했으면 한 번 배포한 뒤에 확인합니다.

### 배포

1. `.env.example` 을 `.env` 로 복사하고 `PUBLISHER_API_KEY` 에 사용자가 준 키를 넣습니다. `.env` 는 절대 깃허브에 올리지 않습니다.
2. `publisher.json` 의 `site` 를 서비스 이름으로 바꿉니다. 영어 소문자, 숫자, 하이픈으로 3~32자이고 이미 다른 사람이 쓰는 이름이면 다른 이름을 고릅니다.
3. `npm run deploy` 를 실행합니다. 빌드부터 업로드, 반영까지 한 번에 하고 마지막에 주소를 보여 줍니다.
4. 오류가 나면 메시지를 읽고 고쳐서 다시 배포합니다. 배포 기록과 되돌리기는 웹 퍼블리셔 대시보드의 **내 사이트** 칸에 있습니다.

### 한도

파일 5,000개, 파일 하나 50MB, 합계 300MB. 한 사람당 사이트 10개, API 키 10개.

## 파일

| 경로 | 무엇 |
|---|---|
| `src/App.tsx` | 첫 화면 |
| `src/webdb.ts` | 데이터 저장 도우미 |
| `publisher.json` | 사이트 이름, 빌드 방법, 데이터 컬렉션 |
| `scripts/publish.mjs` | 배포 스크립트 (설치할 것 없음, Node 18 이상) |
| `.env.example` | API 키 자리 |
