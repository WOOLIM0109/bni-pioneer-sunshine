# 파이오니아 선샤인

BNI 부산 파이오니아 챕터의 선샤인 · 파워팀 · 결원 업종 지도입니다. 화면은 `index.html` 한 파일로 동작하고 GitHub Pages의 `main` / root에서 배포합니다. 빌드나 패키지 설치가 필요 없습니다.

- 나의 선샤인: 핵심고객과 상생직군, 챕터의 연결·결원 업종
- 파워팀: 팀별 공유 핵심고객과 결원
- 챕터 전체 지도: 팀별 충원율과 초대 우선순위
- 멤버 관리: 로그인 후 편집·추가·삭제·일괄 반영·불러오기, 누구나 내보내기

## 데이터와 권한

Supabase `public.members`가 명단의 단일 원본입니다. 누구나 읽을 수 있고, 이메일 매직링크로 로그인한 사용자는 모두 수정할 수 있습니다. 별도 승인 명단은 없습니다. 데이터는 `sort_order`, `name` 순으로 읽고 변경 알림은 Supabase Realtime으로 받습니다.

키가 비어 있거나 서버 연결이 실패하면 HTML에 포함된 31명 시드로 표시하며, 상단에 **오프라인 · 읽기 전용** 배지가 나타납니다. 이때 로그인 여부와 관계없이 편집을 막습니다. 서버 연결이 성공한 빈 테이블은 실제 빈 명단으로 표시되므로 최초 시드 주입까지 마치세요. 브라우저에 저장되어 있던 예전 명단과 상생직군 수정분은 읽거나 저장하지 않습니다.

시드 기준은 경청표 2026.09.02입니다. 박미성 대표는 C단계 질문지·신상명세표 기반 실데이터이며, 나머지 30명의 핵심고객·상생직군은 추정치입니다.

## 1. Supabase 프로젝트 설정

현재 연결 프로젝트는 `BNI Pioneer Sunshine` 무료 조직의 `bni-pioneer-sunshine`입니다. 프로젝트 ID는 `alcvloqlzxpeqtagyffy`, 리전은 서울(`ap-northeast-2`)입니다. 공개 URL과 anon 키는 HTML에 반영했습니다. 테이블 설정과 31명 최초 주입은 관리 연결의 마이그레이션으로 적용했으므로 현재 프로젝트에 시드 스크립트를 다시 실행할 필요가 없습니다.

1. Supabase 프로젝트의 SQL Editor에서 [`supabase/schema.sql`](supabase/schema.sql)을 실행합니다. 테이블, 인덱스, RLS, 역할별 권한, 수정 이력 트리거와 Realtime publication을 설정합니다. 같은 스키마에 재실행할 수 있으며 기존 행을 지우지 않습니다.
2. **Authentication → Providers → Email**에서 Email을 켜고 **Confirm email**을 사용합니다. 소셜 로그인은 필요하지 않습니다. 새 이메일도 가입할 수 있어야 하므로 이메일 신규 가입을 허용합니다.
3. **Authentication → URL Configuration**에서 Site URL을 `https://woolim0109.github.io/bni-pioneer-sunshine/`로 설정합니다. Redirect URLs에도 같은 주소를 추가합니다. 주소에 쿼리 등이 없는 이 정식 URL로 페이지를 여세요. 별도 테스트 주소를 쓸 때는 실제 반환 주소를 추가합니다.
4. 프로젝트의 Project URL과 **anon public key**를 확인하고 `index.html`의 `SUPABASE_URL`, `SUPABASE_ANON_KEY` 상수에 각각 넣습니다. 빈 문자열은 미설정 상태를 뜻합니다. 공개 HTML에는 이 두 공개 설정만 넣으세요.
5. 모든 이메일 주소로 매직링크를 보내려면 **Authentication → Emails → SMTP Settings**에 발송 서비스를 연결해야 합니다. Supabase 기본 메일 발송은 조직 멤버 주소에만 허용되므로 일반 사용자의 이메일 로그인에는 사용할 수 없습니다.

클라이언트는 jsDelivr의 `@supabase/supabase-js@2.45.4` UMD 배포본을 사용합니다. URL이나 버전을 임의로 바꾸지 않아도 됩니다.

## 2. 최초 시드 31명 주입

Node.js 20 이상에서 실행합니다. 추가 패키지는 없습니다. 스크립트는 저장소의 신뢰할 수 있는 `index.html`에 있는 `SEED_MEMBERS_START` / `SEED_MEMBERS_END` 사이의 배열을 읽습니다. 이 구간은 최초 31명 배열로 유지하세요. 원격 HTML은 읽지 않습니다.

먼저 연결 없이 변환 결과를 검증합니다.

```powershell
node seed/seed.mjs --dry-run
```

실제 주입에는 `SUPABASE_URL`과 `SUPABASE_SERVICE_ROLE_KEY` 환경변수가 필요합니다. `service_role` 키는 브라우저에 넣지 말고, 저장소나 `.env` 파일에도 저장하지 마세요. PowerShell에서 키를 화면이나 명령 기록에 남기지 않고 입력하는 예시는 다음과 같습니다.

```powershell
$env:SUPABASE_URL = 'https://프로젝트-ref.supabase.co'
$seedSecret = Read-Host 'Supabase service_role 키' -AsSecureString
$seedPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($seedSecret)
try {
  $env:SUPABASE_SERVICE_ROLE_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($seedPointer)
  node seed/seed.mjs
} finally {
  Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($seedPointer)
  $seedSecret.Dispose()
}
```

스크립트는 먼저 빈 테이블인지 확인합니다. 한 행이라도 있으면 종료하고, 비어 있을 때만 31명을 단일 삽입 요청으로 보냅니다. `sort_order`는 원래 배열 순서의 0~30입니다. 시드는 최초 1회, 한 터미널에서만 실행하세요. 네트워크 오류가 발생한 경우 다시 실행하기 전에 Table Editor에서 이미 삽입되었는지 확인하세요. 서비스 비밀키는 출력하지 않습니다.

## 3. 배포와 확인

저장소 `WOOLIM0109/bni-pioneer-sunshine`의 `main`에 변경을 반영하고 **Settings → Pages → Deploy from a branch → main / (root)**를 확인합니다.

서비스 주소: <https://woolim0109.github.io/bni-pioneer-sunshine/>

1. 로그아웃 브라우저에서 31명이 보이는지, 멤버 관리 입력이 읽기 전용이며 내보내기가 가능한지 확인합니다.
2. 로그인 버튼에 이메일을 입력하고 수신한 매직링크로 로그인합니다. 메일이 오지 않으면 스팸함, Email 공급자 설정과 발송 제한을 확인합니다.
3. 로그인 후 임시 멤버를 추가합니다. 별도 로그아웃 브라우저에 Realtime으로 반영되는지, 새로고침 후에도 보이는지 확인합니다. 검증용 멤버는 로그인 화면에서 삭제합니다.
4. 브라우저 개발자 도구에서 Supabase 요청을 차단하고 새로고침합니다. 시드 31명과 오프라인 배지가 보이고 쓰기가 차단되는지 확인한 뒤 차단을 해제합니다.
5. 밝은·어두운 테마와 폭 400px에서 화면을 확인합니다.

연결 오류는 Project URL·anon key·테이블·RLS를 확인하세요. 쓰기 권한 오류는 다시 로그인한 뒤 스키마의 `authenticated` 권한을 확인하세요. Realtime만 동작하지 않으면 `supabase_realtime` publication에 `public.members`가 등록됐는지 확인하세요.

## 동명이인과 일괄 반영

멤버의 실제 식별자는 UUID입니다. 성함에는 UNIQUE 제약을 두지 않습니다. 일괄 반영은 성함에 해당하는 행이 하나면 수정하고, 없으면 추가합니다. 여러 행이 같은 성함이면 자동으로 결정하지 않고 사용자 확인이 필요한 오류로 처리합니다. 동명이인은 표의 개별 행에서 UUID를 유지해 수정하세요.

일괄 반영은 항목별로 저장합니다. 도중 오류가 나면 성공한 추가·갱신 수를 표시하므로 최신 명단을 확인하고 남은 항목만 다시 반영하세요. JSON 불러오기도 같은 방식으로 병합하며 기존 행을 삭제하지 않습니다. 표에서 다른 사람이 먼저 수정한 행은 덮어쓰지 않고 최신 내용을 다시 읽어 확인하도록 안내합니다.

## 개발 검증

`node tests/browser.mjs`는 별도로 설치된 Playwright/Chromium으로 인증·쓰기·Realtime·실패·400px 화면을 검사합니다. 실행할 때 모든 외부 요청을 차단하고 메모리 DB를 사용하며 실제 사용자나 서버 데이터는 변경하지 않습니다. Playwright 모듈을 찾지 못하면 `PLAYWRIGHT_MODULE` 환경변수로 설치 위치를 지정하세요. 서비스 자체에는 Node.js나 Playwright가 필요 없습니다.

## 다음 단계: 비공개 데이터 분리

현재 `members`는 모든 열을 공개 읽기합니다. 추후 수집되는 실제 **리퍼럴 트리거·좋은 리퍼럴·고객사 명단**을 이 공개 테이블에 그대로 저장하면 안 됩니다. HTML에서 숨기는 것으로는 API 조회를 막을 수 없습니다.

실데이터를 받기 전에 멤버 UUID를 참조하는 비공개 별도 테이블로 민감한 항목을 분리하고, 해당 테이블의 SELECT를 `authenticated`에만 허용하는 RLS와 권한을 적용해야 합니다. 공개 명단과 로그인 전용 상세 조회를 나누고, 공개 HTML에 내장된 오프라인 시드와 내보내기에도 비공개 데이터가 섞이지 않도록 함께 바꾸세요. 이 분리는 이번 구현 범위에 포함하지 않습니다.
