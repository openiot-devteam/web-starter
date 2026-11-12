#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 웹 퍼블리셔 배포 CLI — 의존성 없는 파일 하나(Node 18 이상).
//
// 스타터 저장소에 이 파일을 그대로 넣고 package.json 에 한 줄을 둔다:
//   "scripts": { "deploy": "node scripts/publish.mjs" }
//
// 하는 일
//   1. API 키 확인       PUBLISHER_API_KEY (환경변수 → .env.local → .env 순서로 찾는다)
//   2. 빌드              publisher.json 의 build 명령(예: npm run build)
//   3. 파일 목록 보내기   outDir 폴더 전체
//   4. 올리기            서버가 준 서명된 주소로 S3 에 바로(파일이 우리 서버를 거치지 않는다)
//   5. 마무리·기다리기    서버가 주소에 반영할 때까지
//
// publisher.json
//   { "site": "myshop", "outDir": "dist", "build": "npm run build", "spa": true,
//     "apiUrl": "https://xxxx.execute-api.ap-northeast-2.amazonaws.com",
//     "collections": { "guestbook": "guestbook", "inquiries": "form" } }
//
// collections — 사이트 화면에서 쓸 데이터 묶음. 배포할 때마다 서버를 이 설정에 맞춘다(없으면 만들고, 규칙이
// 다르면 고친다. 여기서 빠진 컬렉션은 지우지 않는다). 값은 아래 이름 하나이거나 규칙 객체다.
//   guestbook  누구나 읽기·쓰기                (방명록, 댓글)
//   form       누구나 쓰기, 읽기는 주인만       (문의, 신청서 — 받은 내용은 대시보드에서 본다)
//   board      누구나 읽기, 쓰기는 주인만       (공지, 메뉴판)
//   poll       누구나 읽기·쓰기·고치기          (투표, 좋아요)
//   private    전부 주인만
//   { "read": "public", "create": "public", "update": "owner", "delete": "owner" }  ← 직접 정하기
//
// 옵션: --site <이름>  --dir <폴더>  --spa / --no-spa  --skip-build  --dry-run  --help
// 계약: docs/api.md 의 '배포 CLI'
// ─────────────────────────────────────────────────────────────────────────────
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const VERSION = "1.0.0";
const CONFIG_FILE = "publisher.json";
const PUT_CONCURRENCY = 6;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

// ── 출력 ────────────────────────────────────────────────────────────────────
const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c("1");
const dim = c("2");
const green = c("32");
const red = c("31");
const cyan = c("36");

const step = (n, msg) => console.log(`${cyan(`[${n}/5]`)} ${msg}`);
const info = (msg) => console.log(`      ${dim(msg)}`);

class Fail extends Error {}
const fail = (msg) => {
  throw new Fail(msg);
};

// ── 설정 ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--site") out.site = argv[++i];
    else if (a === "--dir") out.outDir = argv[++i];
    else if (a === "--spa") out.spa = true;
    else if (a === "--no-spa") out.spa = false;
    else if (a === "--skip-build") out.skipBuild = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else fail(`모르는 옵션입니다: ${a} (--help 로 사용법을 볼 수 있습니다)`);
  }
  return out;
}

/** .env 파일의 KEY=VALUE 를 읽는다. 따옴표는 벗긴다. 이미 있는 환경변수는 덮지 않는다. */
function loadDotenv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

function loadConfig(args) {
  let file = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      file = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    } catch (e) {
      fail(`${CONFIG_FILE} 을 읽지 못했습니다. 쉼표나 따옴표가 빠지지 않았는지 확인해 주세요. (${e.message})`);
    }
  }
  loadDotenv(".env.local");
  loadDotenv(".env");

  const cfg = {
    site: (args.site ?? process.env.PUBLISHER_SITE ?? file.site ?? "").trim().toLowerCase(),
    outDir: args.outDir ?? file.outDir ?? "dist",
    build: file.build ?? "",
    spa: args.spa ?? file.spa ?? false,
    apiUrl: (process.env.PUBLISHER_API_URL ?? file.apiUrl ?? "").replace(/\/+$/, ""),
    apiKey: (process.env.PUBLISHER_API_KEY ?? "").trim(),
    skipBuild: !!args.skipBuild,
    dryRun: !!args.dryRun,
    collections: parseCollections(file.collections),
  };

  if (!cfg.site) {
    fail(`사이트 이름이 없습니다. ${CONFIG_FILE} 의 "site" 에 원하는 이름(영어 소문자·숫자·하이픈)을 적어 주세요.`);
  }
  if (!cfg.apiUrl) fail(`배포 서버 주소가 없습니다. ${CONFIG_FILE} 의 "apiUrl" 을 확인해 주세요.`);
  if (!cfg.apiKey && !cfg.dryRun) {
    fail(
      [
        "API 키가 없습니다.",
        "  1) 웹 퍼블리셔 화면에서 'API 키 만들기' 를 누릅니다.",
        "  2) 이 폴더의 .env 파일에 아래 한 줄을 붙여 넣습니다(파일이 없으면 만듭니다).",
        "     PUBLISHER_API_KEY=wpk_...",
        "  GitHub Actions 로 배포한다면 저장소 Settings → Secrets 에 PUBLISHER_API_KEY 로 넣습니다.",
      ].join("\n"),
    );
  }
  return cfg;
}

// ── 데이터 컬렉션 ───────────────────────────────────────────────────────────

const RULE_PRESETS = {
  guestbook: { read: "public", create: "public" },
  form: { create: "public" },
  board: { read: "public" },
  poll: { read: "public", create: "public", update: "public" },
  private: {},
};
const OPERATIONS = ["read", "create", "update", "delete"];
const COLLECTION_RE = /^[a-z][a-z0-9_-]{0,39}$/;

/** publisher.json 의 collections → [{ name, rules }]. 틀린 곳이 있으면 배포 전에 멈춘다. */
function parseCollections(raw) {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) {
    fail(`${CONFIG_FILE} 의 "collections" 는 { "이름": "guestbook" } 모양이어야 합니다.`);
  }
  return Object.entries(raw).map(([name, value]) => {
    if (!COLLECTION_RE.test(name)) {
      fail(`컬렉션 이름 '${name}' 을 쓸 수 없습니다. 영어 소문자로 시작하고 소문자·숫자·-·_ 만 씁니다(최대 40자).`);
    }
    if (typeof value === "string") {
      const rules = RULE_PRESETS[value];
      if (!rules) fail(`'${name}' 의 "${value}" 는 모르는 종류입니다. ${Object.keys(RULE_PRESETS).join(", ")} 중에서 고르세요.`);
      return { name, rules };
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [op, v] of Object.entries(value)) {
        if (!OPERATIONS.includes(op)) fail(`'${name}' 의 "${op}" 는 모르는 동작입니다. ${OPERATIONS.join(", ")} 만 씁니다.`);
        if (v !== "public" && v !== "owner") fail(`'${name}.${op}' 은 "public"(누구나) 또는 "owner"(주인만) 이어야 합니다.`);
      }
      return { name, rules: value };
    }
    fail(`'${name}' 의 값이 이상합니다. "guestbook" 같은 종류 이름이나 규칙 객체를 넣어 주세요.`);
  });
}

const ruleSummary = (rules) =>
  ["read:읽기", "create:쓰기", "update:고치기", "delete:지우기"]
    .map((s) => s.split(":"))
    .filter(([op]) => rules[op] === "public")
    .map(([, label]) => label)
    .join("·") || "주인만";

// ── 서버 호출 ───────────────────────────────────────────────────────────────

async function api(cfg, method, path, body) {
  let res;
  try {
    res = await fetch(`${cfg.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        ...(body ? { "content-type": "application/json" } : {}),
        "user-agent": `webpub-cli/${VERSION}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    fail(`배포 서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요. (${e.cause?.code ?? e.message})`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = data?.message ?? (data?.issues ? data.issues.map((i) => i.message).join(", ") : text || res.statusText);
    const err = new Fail(msg);
    err.status = res.status;
    err.code = data?.error;
    throw err;
  }
  return data;
}

// ── 파일 ────────────────────────────────────────────────────────────────────

/** 폴더 안 파일 전부. 숨김 파일(.env, .DS_Store 등)은 뺀다. .well-known 만 예외. */
function walk(root) {
  const out = [];
  const visit = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      const rel = relative(root, full).split(sep).join("/");
      if (ent.name.startsWith(".") && rel !== ".well-known") continue;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) visit(full);
      else if (ent.isFile()) out.push({ path: rel, full, size: statSync(full).size });
    }
  };
  visit(root);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

async function putFile(upload, full) {
  const body = await readFile(full);
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(upload.url, { method: "PUT", headers: upload.headers, body });
      if (res.ok) return;
      if (attempt >= 3 || (res.status < 500 && res.status !== 429)) {
        fail(`${upload.path} 를 올리지 못했습니다(${res.status}). 다시 배포해 주세요.`);
      }
    } catch (e) {
      if (e instanceof Fail) throw e;
      if (attempt >= 3) fail(`${upload.path} 를 올리지 못했습니다(${e.message}). 인터넷 연결을 확인해 주세요.`);
    }
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
}

async function mapLimit(items, n, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

function gitInfo() {
  const run = (cmd) => {
    try {
      return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return undefined;
    }
  };
  return {
    source: process.env.GITHUB_ACTIONS === "true" ? "github-actions" : "cli",
    commit: (process.env.GITHUB_SHA ?? run("git rev-parse HEAD"))?.slice(0, 12),
    message: run("git log -1 --pretty=%s")?.slice(0, 300),
  };
}

// ── 본체 ────────────────────────────────────────────────────────────────────

function help() {
  console.log(`웹 퍼블리셔 배포 ${VERSION}

  npm run deploy                 publisher.json 대로 빌드하고 배포
  npm run deploy -- --skip-build 빌드 없이 지금 폴더 그대로 배포
  npm run deploy -- --dry-run    올릴 파일 목록만 보기

옵션: --site <이름>  --dir <폴더>  --spa | --no-spa  --skip-build  --dry-run`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return help();

  const cfg = loadConfig(args);
  console.log(bold(`\n웹 퍼블리셔로 '${cfg.site}' 를 배포합니다\n`));

  // 1. 키 확인 — 빌드를 기다린 뒤에 키가 틀렸다는 것을 알면 허탈하다.
  step(1, "API 키를 확인합니다");
  if (cfg.dryRun) info("(--dry-run: 건너뜀)");
  else {
    const me = await api(cfg, "GET", "/v1/whoami");
    info(`${me.email ?? "알 수 없는 계정"} · 키 '${me.keyName}'`);
  }

  // 2. 빌드
  step(2, "사이트를 빌드합니다");
  if (cfg.skipBuild || !cfg.build) info(cfg.build ? "(--skip-build: 건너뜀)" : "(빌드 명령 없음: 건너뜀)");
  else {
    info(`$ ${cfg.build}`);
    const r = spawnSync(cfg.build, { shell: true, stdio: "inherit" });
    if (r.status !== 0) fail("빌드가 실패했습니다. 위의 오류를 고친 뒤 다시 실행해 주세요.");
  }

  // 3. 파일 목록
  const root = resolve(cfg.outDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    fail(`'${cfg.outDir}' 폴더가 없습니다. 빌드가 끝났는지, ${CONFIG_FILE} 의 outDir 이 맞는지 확인해 주세요.`);
  }
  const files = walk(root);
  const total = files.reduce((s, f) => s + f.size, 0);
  step(3, `파일 ${files.length}개(${formatBytes(total)})를 준비했습니다`);
  if (!files.some((f) => f.path === "index.html")) {
    fail(`'${cfg.outDir}' 안에 index.html 이 없습니다. 빌드 결과 폴더가 맞는지 확인해 주세요.`);
  }
  if (cfg.dryRun) {
    for (const f of files) info(`${f.path}  ${formatBytes(f.size)}`);
    for (const col of cfg.collections) info(`데이터 '${col.name}' — 누구나: ${ruleSummary(col.rules)}`);
    console.log(green("\n--dry-run: 여기까지만 확인했습니다. 실제로 올리지 않았습니다."));
    return;
  }

  const created = await api(cfg, "POST", `/v1/sites/${encodeURIComponent(cfg.site)}/deployments`, {
    files: files.map((f) => ({ path: f.path, size: f.size })),
    spa: cfg.spa,
    ...gitInfo(),
  });
  const { deployment, site, uploadBatchSize } = created;
  const base = `/v1/sites/${encodeURIComponent(site.slug)}/deployments/${deployment.deploymentId}`;

  // 데이터 컬렉션 — 새 화면이 공개되기 전에 맞춰 둔다(화면이 먼저 뜨면 잠깐 404 가 난다).
  for (const col of cfg.collections) {
    const r = await api(cfg, "PUT", `/v1/sites/${encodeURIComponent(site.slug)}/collections/${col.name}`, {
      rules: col.rules,
    });
    info(`데이터 '${r.name}' (${r.docCount.toLocaleString("en-US")}개) — 누구나: ${ruleSummary(r.rules)}`);
  }

  // 4. 올리기
  step(4, "파일을 올립니다");
  const byPath = new Map(files.map((f) => [f.path, f]));
  let done = 0;
  for (let i = 0; i < files.length; i += uploadBatchSize) {
    const batch = files.slice(i, i + uploadBatchSize);
    const { uploads } = await api(cfg, "POST", `${base}/upload-urls`, { paths: batch.map((f) => f.path) });
    await mapLimit(uploads, PUT_CONCURRENCY, async (u) => {
      await putFile(u, byPath.get(u.path).full);
      done++;
      if (tty) process.stdout.write(`\r      ${done}/${files.length}`);
    });
  }
  if (tty) process.stdout.write("\n");
  else info(`${done}/${files.length}`);

  // 5. 마무리
  step(5, "주소에 반영합니다");
  let current = (await api(cfg, "POST", `${base}/finalize`)).deployment;
  const started = Date.now();
  let url = site.url;
  while (current.status === "activating" || current.status === "uploading") {
    if (Date.now() - started > POLL_TIMEOUT_MS) {
      fail("반영이 오래 걸리고 있습니다. 잠시 뒤 웹 퍼블리셔 화면에서 상태를 확인해 주세요.");
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const s = await api(cfg, "GET", base);
    current = s.deployment;
    url = s.url ?? url;
  }

  if (current.status !== "ready") fail(current.error ?? "배포를 마치지 못했습니다. 다시 시도해 주세요.");

  console.log(green(bold("\n배포가 끝났습니다!")));
  console.log(`  ${bold(url)}\n`);
}

main().catch((err) => {
  if (err instanceof Fail) {
    console.error(red(`\n배포하지 못했습니다\n`));
    console.error(err.message);
    if (err.status === 401) console.error(dim("\n키를 새로 만들었다면 .env 의 PUBLISHER_API_KEY 를 바꿨는지 확인해 주세요."));
    if (err.code === "SLUG_TAKEN") console.error(dim(`\n${CONFIG_FILE} 의 "site" 를 다른 이름으로 바꿔 주세요.`));
  } else {
    console.error(red("\n예상하지 못한 오류가 났습니다"), err);
  }
  process.exit(1);
});
