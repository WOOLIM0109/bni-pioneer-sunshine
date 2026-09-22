# 파이오니아 선샤인

BNI 부산 파이오니아 챕터의 선샤인 · 파워팀 · 결원 업종 지도입니다. 화면의 원본은 `index.html` 한 파일이며, GitHub Actions에서 페이지별 정적 HTML을 생성해 GitHub Pages에 배포합니다. 별도 패키지 설치는 필요 없습니다.

- 나의 선샤인: 핵심고객과 상생직군, 챕터의 연결·결원 업종
- 파워팀: 팀별 공유 핵심고객과 결원
- 챕터 전체 지도: 팀별 충원율과 초대 우선순위
- 멤버 관리: 승인된 본인 정보 수정, 관리자의 명단·권한·인터뷰 문서 관리, 누구나 공개 명단 내보내기

각 화면은 아래 주소로 바로 열거나 공유할 수 있습니다. 기존 루트 주소도 나의 선샤인 화면으로 계속 열립니다.

| 화면 | 슬러그 |
|---|---|
| 나의 선샤인 | `/sunshine/` |
| 파워팀 | `/power-teams/` |
| 챕터 전체 지도 | `/chapter-map/` |
| 멤버 관리 | `/members/` |

운영 주소에서는 `/bni-pioneer-sunshine/` 뒤에 슬러그가 붙습니다. 페이지마다 제목·설명·canonical·Open Graph가 정적 HTML에 포함되며 공유 이미지는 `assets/pioneer-sunshine-share.png`를 함께 사용합니다. 메뉴를 이동해도 입력 중인 내용은 유지되고 브라우저 뒤로·앞으로 가기로 화면을 이동할 수 있습니다. 가입 확인·비밀번호 재설정 메일은 기존에 허용한 앱 루트 주소로 돌아옵니다.

## 데이터와 권한

Supabase `public.members`가 명단의 단일 원본입니다. 데이터는 `sort_order`, `name` 순으로 읽고 변경 알림은 Supabase Realtime으로 받습니다.

| 구분 | 읽기 | 수정 |
|---|---|---|
| 비로그인·읽기 전용 계정 (`viewer`) | 공개 명단 전체 | 불가 |
| 승인된 멤버 (`member`) | 공개 명단 전체 | 연결된 본인 멤버의 정보만 |
| 전체 관리자 (`admin`) | 공개 명단 전체·가입 계정 | 전체 멤버 추가·수정·삭제, 일괄 반영·불러오기, 계정 권한 승인·변경 |

처음에는 **처음 가입 → 이름·이메일·비밀번호 입력 → 가입 확인 메일의 링크 누르기**로 가입합니다. 이름은 가입할 때 필수이며 앞뒤 공백과 연속 공백을 정리해 최대 80자로 받습니다. 다음부터는 **이메일과 비밀번호로 로그인**합니다. 같은 브라우저에서는 로그인 상태가 유지됩니다. 비밀번호를 잊었거나 이전에 이메일 링크로만 가입했다면 로그인 창의 비밀번호 설정·재설정 기능으로 메일을 받아 새 비밀번호를 정합니다. 이미 로그인한 사용자는 비밀번호 설정 버튼으로 설정할 수 있습니다.

가입만으로 수정 권한이 생기지는 않습니다. 관리자는 가입자 권한 관리에서 이름·이메일·인증 상태를 함께 확인하고, 이름이나 이메일로 검색해 승인할 수 있습니다. 승인 요청을 먼저 표시하며, 아직 연결을 신청하지 않은 새 가입자는 명단에서 이름이 일치하는 사람이 한 명이고 다른 계정에 연결되지 않았을 때만 후보를 미리 선택합니다. 후보가 맞는지 확인하고 **승인 · 저장**을 눌러야 권한이 생깁니다. 동명이인·이름 불일치·이미 연결된 멤버는 관리자가 직접 확인합니다. 기존의 본인 멤버 연결 신청도 계속 사용할 수 있고, 이름을 받기 전 가입한 계정은 **가입 이름 미등록**으로 표시합니다. 명단을 보는 분은 가입할 필요가 없습니다.

가입 이름은 Supabase Auth의 `full_name` 사용자 메타데이터에 저장하며 관리자 전용 목록 RPC가 표시용으로 반환합니다. 사용자가 입력한 이름이나 이름 일치 여부로 권한을 부여하지 않습니다. 이메일 인증과 DB의 관리자 승인 검사는 그대로 적용됩니다.

권한 관리 목록에는 각 계정의 이메일 인증 상태가 표시됩니다. **이메일 인증 대기**인 계정은 가입 확인 메일의 링크를 누른 뒤 본인 수정·관리자 권한을 받을 수 있습니다. 읽기 권한으로 내리거나 요청을 반려하는 작업은 인증 대기 중에도 가능합니다. 저장 실패 이유는 해당 계정 옆에 표시되며, 실패한 선택과 다른 계정의 미저장 선택은 유지됩니다. 로그인 자동 갱신은 진행 중인 저장의 권한 확인이 끝난 뒤 처리합니다.

기존 설치를 업데이트할 때는 `supabase/roles.sql`을 먼저 적용한 뒤 화면을 배포합니다. 관리자 목록은 관리자 전용 `list_member_accounts` RPC에서 계정 정보와 인증 여부만 읽으며, 일반 사용자에게 다른 계정의 이메일·인증 상태를 공개하지 않습니다.

계정 이메일과 멤버 연결은 `public.member_accounts`에 저장하며, 본인 계정과 관리자에게만 읽기를 허용합니다. 감사용 `members.updated_by` 이메일도 공개 조회에서 제외합니다. 브라우저가 역할·이메일·연결 UUID를 직접 수정할 수 없습니다. 신청과 승인은 인증된 사용자에게만 열린 제한된 RPC를 사용하고, 실제 멤버 쓰기는 DB의 RLS로 다시 검사합니다. 일반 멤버는 본인의 내용만 수정하며 명단 순서와 신입·실데이터 관리 표시는 관리자가 변경합니다.

인터뷰 원본 파일·추출 원문·AI 제안·검토 기록은 **관리자만** 읽고 저장합니다. `private` 스키마와 비공개 Storage 버킷 `member-interviews`에 보관하며, 공개 Realtime·JSON 내보내기·오프라인 시드에는 포함하지 않습니다. 좋은 리퍼럴·리퍼럴 트리거·실제 고객사명은 `private.member_details`로 분리되어 관리자와 승인된 해당 멤버만 열람할 수 있습니다. 공개 `customers`에는 실제 고객사 실명 대신 고객 유형을 기록합니다.

## 인터뷰 문서로 선샤인 업데이트하기

1. 관리자 로그인 후 **멤버 관리 → 인터뷰로 선샤인 다듬기**에서 멤버의 이름·회사를 선택합니다. 문서의 이름만으로 자동 연결하지 않습니다.
2. PDF, Word `.docx`, UTF-8 `.txt` 파일을 선택하고 **문서 올리기**를 누릅니다. 최대 10MiB, PDF 60쪽, 추출 원문 120,000자입니다. `.doc`·한글 문서는 먼저 PDF 또는 DOCX로 저장하세요. 암호가 걸린 문서는 암호를 제거한 사본이 필요합니다.
3. **AI 분석하기**를 누릅니다. PDF는 페이지의 이미지와 텍스트를, Word·TXT는 추출한 텍스트를 OpenAI API로 전송합니다. 스캔 PDF도 분석할 수 있으나 이미지 속 글자와 표는 반드시 원문과 대조하세요. Word의 그림 속 글자가 중요하면 PDF로 변환해서 올리세요.
4. 현재 내용, AI 제안, 문서 근거를 비교합니다. 핵심고객 유형·상생직군·파워팀 등을 직접 고치고 반영할 항목만 체크합니다. AI 제안은 처음에 모두 미선택이며 빈 항목 때문에 기존 정보가 지워지지 않습니다.
5. 대상 멤버와 공개 범위를 확인한 뒤 **선택한 N개 항목 반영**을 누릅니다. 성공 응답 뒤 선샤인·파워팀·챕터 지도가 함께 갱신됩니다. **검토 내용 보관**은 초안만 저장하며 명단은 바꾸지 않습니다.

보관 문서에서 원본과 이전 검토안을 다시 열 수 있습니다. 이미 반영한 문서는 중복 반영하지 못하므로 수정 자료는 새 문서로 올립니다. 검토 중 다른 관리자가 멤버 정보를 바꾸면 저장을 막고 다시 비교하도록 안내합니다. 원문이 연결된 멤버는 보관 기록을 보호하기 위해 삭제가 제한됩니다.

### AI 서버 연결 — 최초 한 번

1. 기존 역할 설정 후 [`supabase/interviews.sql`](supabase/interviews.sql)을 적용합니다. 기존 공개 리퍼럴·트리거는 비공개 테이블로 옮기고 공개 복사본을 비웁니다. 재실행은 가능하지만 공개·비공개 값이 충돌하면 중단합니다.
2. [`supabase/functions/analyze-interview/index.ts`](supabase/functions/analyze-interview/index.ts)를 `analyze-interview` Edge Function으로 배포하고 JWT 검증을 켭니다. 함수는 Auth의 실제 사용자와 DB의 관리자 역할을 다시 확인합니다. 데이터베이스 관리자 키는 사용하지 않습니다.
3. Supabase **Edge Functions → Secrets**에 `OPENAI_API_KEY`를 등록합니다. API 키는 채팅, HTML, 저장소에 넣지 않습니다. 기본 `SUPABASE_URL`·`SUPABASE_ANON_KEY`는 Edge Function 서버 환경에서 읽습니다. 개발용 Origin이 필요하면 `ALLOWED_ORIGINS`에 허용할 출처를 쉼표로 명시합니다. 기본값은 `https://woolim0109.github.io,https://sunshine.bni-pioneer.com`이며, `ALLOWED_ORIGINS`를 지정하면 기본 목록을 대체하므로 운영에 필요한 출처를 모두 포함하세요.
4. OpenAI API 프로젝트의 결제·사용 한도를 확인하고 페이지를 새로고침합니다. ChatGPT 구독과 API 사용료는 별도입니다. 현재 분석 모델은 `gpt-5.4-mini-2026-03-17`이며 최대 출력 6,000토큰, 문서별 중복 분석 방지와 100초 요청 제한을 적용합니다. API 응답 보관 옵션은 `store:false`입니다. 공급자의 별도 데이터 처리 정책은 [OpenAI API 데이터 안내](https://developers.openai.com/api/docs/guides/your-data)를 확인하세요.

프런트엔드는 계속 `index.html` 한 파일입니다. 문서 판독기는 필요할 때만 jsDelivr의 고정 버전 PDF.js `6.3.289`와 Mammoth `1.12.3`을 불러옵니다. 파일 원문을 브라우저 저장소에 보관하지 않으며, 계정 전환·권한 상실 때 비공개 메모리와 화면을 지웁니다.

키가 비어 있거나 서버 연결이 실패하면 HTML에 포함된 31명 시드로 표시하며, 상단에 **오프라인 · 읽기 전용** 배지가 나타납니다. 이때 로그인 여부와 관계없이 편집을 막습니다. 서버 연결이 성공한 빈 테이블은 실제 빈 명단으로 표시되므로 최초 시드 주입까지 마치세요. 브라우저에 저장되어 있던 예전 명단과 상생직군 수정분은 읽거나 저장하지 않습니다.

시드 기준은 경청표 2026.09.02입니다. 박미성 대표는 C단계 질문지·신상명세표 기반 실데이터이며, 나머지 30명의 핵심고객·상생직군은 추정치입니다.

## 1. Supabase 프로젝트 설정

현재 연결 프로젝트는 `BNI Pioneer Sunshine` 무료 조직의 `bni-pioneer-sunshine`입니다. 프로젝트 ID는 `alcvloqlzxpeqtagyffy`, 리전은 서울(`ap-northeast-2`)입니다. 공개 URL과 anon 키는 HTML에 반영했습니다. 테이블 설정과 31명 최초 주입은 관리 연결의 마이그레이션으로 적용했으므로 현재 프로젝트에 시드 스크립트를 다시 실행할 필요가 없습니다.

1. 신규 프로젝트는 Supabase SQL Editor에서 [`supabase/schema.sql`](supabase/schema.sql)을 실행합니다. 기존 공유 명단 프로젝트에는 [`supabase/roles.sql`](supabase/roles.sql)을 적용합니다. 역할별 RLS, 계정 연결, 수정 이력과 Realtime을 설정하며 기존 명단을 지우지 않습니다.
2. **Authentication → Providers → Email**에서 Email을 켜고 **Confirm email**을 사용합니다. 소셜 로그인은 필요하지 않습니다. 새 이메일도 가입할 수 있어야 하므로 이메일 신규 가입을 허용합니다.
3. **Authentication → URL Configuration**에서 Site URL을 `https://woolim0109.github.io/bni-pioneer-sunshine/`로 설정합니다. Redirect URLs에도 같은 주소를 추가합니다. 주소에 쿼리 등이 없는 이 정식 URL로 페이지를 여세요. 별도 테스트 주소를 쓸 때는 실제 반환 주소를 추가합니다.
4. 프로젝트의 Project URL과 **anon public key**를 확인하고 `index.html`의 `SUPABASE_URL`, `SUPABASE_ANON_KEY` 상수에 각각 넣습니다. 빈 문자열은 미설정 상태를 뜻합니다. 공개 HTML에는 이 두 공개 설정만 넣으세요.
5. 가입 확인·비밀번호 재설정 메일은 **Authentication → Emails → SMTP Settings**의 발송 서비스를 사용합니다. 현재 프로젝트는 Resend의 `smtp.resend.com:465`와 `파이오니아 선샤인 <sunshine@woolimcompany.kr>` 발신 설정을 사용합니다. 비밀키는 Supabase 설정에만 저장하며 저장소에 넣지 않습니다.
6. 최초 관리자는 운영자가 지정한 이메일로 가입·인증한 계정을 확인한 뒤 DB에서 한 번 지정합니다. 브라우저에는 최초 관리자 승격 기능이 없습니다. 이후 관리자는 멤버 관리의 계정 권한 화면에서 승인·변경합니다. 마지막 관리자 계정을 해제할 수 없으므로 관리자를 교체할 때 새 관리자를 먼저 지정하세요.

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

## 연결 검토와 모바일 관리

기존 역할 설정 이후 [`supabase/connections.sql`](supabase/connections.sql)을 실행합니다. `member_synergy_links`는 관리자 확정 결과만 보관하며 누구나 읽을 수 있습니다. 직접 쓰기는 허용하지 않고, 실제 관리자 권한과 멤버·연결의 수정 시각을 확인하는 RPC로만 확정·해제합니다. 인터뷰 원문과 비공개 리퍼럴은 이 테이블에 저장하지 않습니다.

- **멤버 관리 → 상생직군 연결 검토**를 펼치고 멤버를 선택합니다. 관련 업종은 후보이며 자동 확정되지 않습니다. 실제 제공 서비스를 확인하고 대상 멤버를 선택해 **연결 확정**을 누릅니다. 원래 상생직군 문구를 유지하며, 확정 결과는 나의 선샤인·파워팀·챕터 지도에 함께 반영됩니다. **확정 해제**로 관리자 지정 연결만 제거할 수 있습니다.
- 공백·기호만 다른 같은 업종은 동일하게 찾으며, 같은 업종의 멤버가 여러 명이면 모두 표시합니다. 유사 표현 후보 검색에는 별도 AI 호출이나 사용료가 없습니다.
- 휴대폰에서는 멤버 관리 상단에서 **이름·회사·업종 검색 → 멤버 한 명 선택 → 정보 수정** 순서로 사용합니다. 선택은 이름 대신 UUID로 유지되며, PC에서는 기존 전체 표를 볼 수 있습니다. 본인 정보 수정 권한과 비로그인 읽기 제한은 동일합니다.
- 인터뷰의 **검토 내용 보관**은 현재 체크 상태를 그대로 저장합니다. 체크 해제 및 검토 완료 해제도 다시 불러올 때 유지됩니다. API의 일반 부분 저장은 기존 병합 동작을 유지하며, 검토 화면만 `replace_review: true`로 전체 선택 집합을 저장합니다.

## 3. 배포와 확인

저장소 `WOOLIM0109/bni-pioneer-sunshine`의 `main`에 변경을 반영하고 **Settings → Pages → Source → GitHub Actions**를 사용합니다. [Pages workflow](.github/workflows/pages.yml)가 빌드 검증 후 `_site/`만 배포합니다.

로컬에서는 Node.js 24 이상으로 `node scripts/build-pages.mjs`를 실행합니다. `index.html`의 `PAGE_ROUTES_START` / `PAGE_ROUTES_END` 사이 정의로 각 경로의 `index.html`을 생성하므로 결과물을 직접 수정하거나 커밋하지 않습니다. `node tests/pages-build.mjs`는 경로별 초기 화면·메타정보·메뉴 링크를 검증합니다. 커스텀 도메인 연결 시 workflow가 GitHub Pages의 기본 URL을 빌드에 전달합니다.

현재 운영 주소: <https://woolim0109.github.io/bni-pioneer-sunshine/>

연결 예정 주소는 `https://sunshine.bni-pioneer.com/`입니다. 현재 DNS 담당자의 접근 가능 여부를 기다리고 있어 기존 주소로 운영하며, 저장소의 `CNAME` 파일과 GitHub Pages Custom domain은 아직 설정하지 않았습니다. 준비가 완료되면 **GitHub Pages Custom domain 등록 → 카페24 DNS CNAME 변경 → DNS·HTTPS 확인 → Supabase Auth Site URL 전환**을 연속으로 진행합니다. Pages에는 `sunshine.bni-pioneer.com`을 먼저 등록하고, DNS는 **CNAME / 호스트 `sunshine` / 대상 `woolim0109.github.io`**로 설정합니다.

현재 확인된 `sunshine`의 CNAME 응답은 `bni-pioneer.com`이며 와일드카드에서 나온 응답일 수도 있습니다. DNS 관리 화면에서 기존 `sunshine` 기록이 있으면 수정하고, 없으면 명시적으로 추가합니다. 다른 루트 도메인(apex)·메일 관련 기록은 그대로 보존합니다. DNS·HTTPS가 정상임을 확인한 뒤 Supabase의 Site URL·Redirect URLs, AI 분석 CORS, 기존 주소에서의 이동과 로그인·비밀번호 재설정 메일의 반환 주소를 확인합니다.

1. 로그아웃 브라우저에서 31명이 보이는지, 멤버 관리 입력이 읽기 전용이며 내보내기가 가능한지 확인합니다.
2. 새 계정은 가입 확인 메일로 이메일을 인증한 뒤 이메일·비밀번호로 로그인합니다. 비밀번호 재설정 메일의 링크로 새 비밀번호 저장이 가능한지도 확인합니다.
3. 새 계정은 읽기만 가능한지 확인합니다. 본인 멤버 연결을 신청하고 관리자가 승인한 뒤 연결된 한 행만 수정되는지 확인합니다. 관리자의 추가·삭제·일괄 반영과 별도 로그아웃 브라우저의 변경 반영도 확인합니다. 실제 운영 명단 대신 별도 검증 환경을 사용하세요.
4. 브라우저 개발자 도구에서 Supabase 요청을 차단하고 새로고침합니다. 시드 31명과 오프라인 배지가 보이고 쓰기가 차단되는지 확인한 뒤 차단을 해제합니다.
5. 밝은·어두운 테마와 폭 400px에서 화면을 확인합니다.

연결 오류는 Project URL·anon key·테이블·RLS를 확인하세요. 쓰기 권한 오류는 본인 계정의 승인 상태와 멤버 연결을 확인하세요. 관리자는 `member_accounts` 역할과 `supabase/roles.sql` 적용 상태를 확인합니다. Realtime만 동작하지 않으면 `supabase_realtime` publication에 `public.members`가 등록됐는지 확인하세요.

## 동명이인과 일괄 반영

멤버의 실제 식별자는 UUID입니다. 성함에는 UNIQUE 제약을 두지 않습니다. 일괄 반영은 성함에 해당하는 행이 하나면 수정하고, 없으면 추가합니다. 여러 행이 같은 성함이면 자동으로 결정하지 않고 사용자 확인이 필요한 오류로 처리합니다. 동명이인은 표의 개별 행에서 UUID를 유지해 수정하세요.

일괄 반영은 항목별로 저장합니다. 도중 오류가 나면 성공한 추가·갱신 수를 표시하므로 최신 명단을 확인하고 남은 항목만 다시 반영하세요. JSON 불러오기도 같은 방식으로 병합하며 기존 행을 삭제하지 않습니다. 표에서 다른 사람이 먼저 수정한 행은 덮어쓰지 않고 최신 내용을 다시 읽어 확인하도록 안내합니다.

## 개발 검증

`node tests/browser.mjs`는 별도로 설치된 Playwright/Chromium으로 인증·쓰기·Realtime·실패·400px 화면을 검사합니다. 실행할 때 모든 외부 요청을 차단하고 메모리 DB를 사용하며 실제 사용자나 서버 데이터는 변경하지 않습니다. Playwright 모듈을 찾지 못하면 `PLAYWRIGHT_MODULE` 환경변수로 설치 위치를 지정하세요. 서비스 자체에는 Node.js나 Playwright가 필요 없습니다.

[`tests/roles.sql`](tests/roles.sql)은 별도 검증 DB에 스키마를 적용한 뒤 관리자 연결로 실행하는 권한 검사입니다. 익명·읽기·본인 수정·관리자 역할을 전환하며 직접 권한 상승 차단, 본인 행만 수정, 승인·해제, 마지막 관리자 보호를 검사합니다. 테스트 계정과 행은 마지막에 `ROLLBACK`으로 되돌립니다. 운영 데이터 대신 격리된 검증 DB를 사용하세요.

```powershell
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/roles.sql
```

[`tests/interviews.sql`](tests/interviews.sql)은 원문 보관·검토 선택·공개/비공개 반영을, [`tests/connections.sql`](tests/connections.sql)은 연결 읽기·관리자 확정·동시 수정 충돌·해제를 검증합니다. 두 검사는 각각 해당 설정 SQL까지 적용된 별도 검증 DB에서 실행하세요.

## 비공개 데이터 유지

리퍼럴 트리거·좋은 리퍼럴·고객사 명단은 `supabase/interviews.sql`의 비공개 테이블에 분리되어 있으며 관리자와 승인된 해당 멤버만 전용 RPC로 조회할 수 있습니다. 인터뷰 원문·분석 제안·검토 이력은 관리자만 조회합니다. 공개 명단, 연결 매핑, HTML 오프라인 시드, 내보내기에 비공개 내용을 복사하지 마세요.
