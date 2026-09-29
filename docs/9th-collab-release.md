# 9기 협업팀 운영 반영 순서

이 문서는 **사용자가 Supabase SQL Editor에서 수동으로 실행할 절차**입니다. 로컬 검증은 운영 DB와 분리된 테스트 DB·브라우저 모의 데이터로 진행합니다. SQL을 자동 실행하는 배포 작업은 추가하지 않습니다. **push와 Edge Function 배포는 로컬 결과 확인 후 별도 승인 때 진행합니다.**

## 적용 전 확인한 기준

- 기존 멤버 33명: 칸 이동 대상 32명 + 삭제 대상 김철홍 1명.
- 이은성은 아직 미등록이며, `밝은소리라이프 / 기업행사, MC / 신입`으로 1명 추가합니다.
- 이서원은 운영 DB에 존재하지 않습니다. 삭제 대상이나 무소속 멤버가 아니라 **이번 등록에서 제외한 타 챕터 인원**입니다.
- 적용 후 총원: `33 - 1 + 1 = 33명`.
- 초기 협업팀 소속 합계: `4 + 10 + 9 + 5 + 5 = 33명`. 초기에는 33명 모두 정확히 한 팀에 소속됩니다. 이후 복수 소속을 지정하면 소속 행 수는 전체 멤버 수보다 커질 수 있습니다.
- 김철홍 원본은 `private.members_backup_20260929`에 남습니다. 백업과 함수 원본은 브라우저에서 읽을 수 없습니다.

## 실행 순서표

아래 순서를 건너뛰지 마세요. 확인 결과가 기대값과 다르면 다음 단계로 진행하지 않습니다.

| 단계 | 수동 작업 | 확인 및 기대 결과 |
|---|---|---|
| 1 · 백업과 미리보기 | [`member_columns_9th_preview.sql`](../supabase/member_columns_9th_preview.sql) 실행 | 첫 데이터 작업으로 백업 생성. **members UPDATE/DELETE/INSERT는 없음**. 마지막 결과가 32행이며 각 행에 이름·회사·전문분야·역할의 변경 전/후 값이 나란히 표시됩니다. |
| 2 · 눈으로 확인 | 아래 ‘미리보기 확인 쿼리’를 실행하고 32명 전체를 검토 | 백업 33명, 백업 속 김철홍 1명. 송승훈 등 모든 매핑이 맞는지 확인. 여기서는 기다려도 원본 명단이 바뀌지 않습니다. |
| 3 · 0번 실제 변경 | 확인한 뒤에만 [`member_columns_9th_apply.sql`](../supabase/member_columns_9th_apply.sql) 실행 | 32명 칸 이동, 김철홍 삭제, 이은성 추가가 한 트랜잭션으로 처리됩니다. 미리보기 이후 원본이 바뀌었으면 실행을 중단합니다. |
| 4 · 멤버 검산 | [`collab_teams_verify.sql`](../supabase/collab_teams_verify.sql)의 1~3번 SELECT를 각각 실행 | 백업 33 / 김철홍 백업 1 / 현재 33 / 김철홍 현재 0 / 이은성 1 / 이서원 0. 기존 32명 변환 일치 32. |
| 5 · 협업팀 설치 | [`collab_teams.sql`](../supabase/collab_teams.sql) 실행 | 팀·소속·권한·관리 RPC·인터뷰 team 제외 처리를 적용합니다. 이 파일이 업그레이드에 필요한 함수 변경도 포함하므로 기존 `schema.sql`이나 인터뷰 설치 파일 전체를 다시 실행할 필요가 없습니다. |
| 6 · 팀과 권한 검산 | `collab_teams_verify.sql`의 4~9번 SELECT를 각각 실행 | 5개 팀, 인원 4/10/9/5/5, 소속 행 33, 소속된 고유 멤버 33, 무소속 0, 복수 소속 0, 잘못된 팀장 0, 미등록 이름 0. 직접 단톡방 조회 권한 false/false. 운영진 안내 대상 5명. |
| 7 · 배포 확인 | 로컬 결과와 위 조회 결과를 확인하고 배포 승인 | 승인 전에는 Git push와 Edge 배포를 하지 않습니다. |
| 8 · AI와 화면 배포 | 승인 후 새 `analyze-interview` 배포(JWT 검증 유지), 이어 검증한 커밋을 main에 push | 새 AI가 팀·역할을 제안하지 않아야 합니다. GitHub Pages 성공 후 `/collab-teams/`와 기존 `/power-teams/` 이동을 확인합니다. |
| 9 · 사용자 흐름 확인 | 새로고침 후 협업팀·멤버 관리·통합 분석 확인 | 5개 팀과 역할 표시, 관리자 매트릭스, 본인 팀 단톡방, 경청표 미리보기, 기존 리퍼럴 공유가 정상이어야 합니다. |

### 미리보기 확인 쿼리

```sql
select count(*) as backup_members,
       count(*) filter(where name='김철홍') as kim_in_backup
from private.members_backup_20260929;
-- 기대값: 33 / 1
```

32명 대조표는 백업을 다시 만들지 않고 아래 SELECT만 다시 실행할 수 있습니다.

```sql
select name as before_name,
       case when name='이 훈' then '이훈' else name end as after_name,
       company as before_company, field as after_company,
       field as before_field, team as after_field,
       to_jsonb(b)->>'chapter_role' as before_chapter_role,
       case when name='권두현' then null
            else nullif(btrim(company),'') end as after_chapter_role
from private.members_backup_20260929 b
where name<>'김철홍'
order by sort_order,name;
-- 기대값: 32행. 이 SELECT는 members를 변경하지 않습니다.
```

송승훈의 변경 후 값은 다음과 같습니다.

| 항목 | 기대값 |
|---|---|
| 회사 | 앱 개발 · 맞춤형 미니 앱 제작 · 디지털 명함(DiCA) |
| 전문분야 | 앱,웹개발(디지탈명함) |
| 역할 | 121마스터 |

### 팀별 기대 결과

| 협업팀 | 팀장 | 팀장 포함 인원 |
|---|---|---:|
| 라이프 이벤트 협업팀 | 마루이 | 4 |
| 부동산&공간 협업팀 | 박선영 | 10 |
| B2B 기업지원 협업팀 | 송승훈 | 9 |
| 웰니스 협업팀 | 이채홍 | 5 |
| 푸드·기프트&프랜차이즈 협업팀 | 임춘식 | 5 |
| 합계 | | **33** |

`이소연`은 웰니스, `이은성`은 B2B 기업지원에 있어야 합니다. 이름이 중복되거나 명단과 맞지 않을 때는 임의 멤버를 추가하지 않고 확인 대상으로 남깁니다.

## SQL과 배포 사이에 시간이 벌어지는 경우

- **미리보기만 실행한 상태:** 실제 members와 기존 화면은 그대로입니다. 이후 원본이 바뀌면 apply가 중단되므로 오래된 대조표로 덮어쓰지 않습니다. 기존 백업을 삭제하거나 다시 만들지 말고 변경분을 확인해야 합니다.
- **0번 적용 후, 새 화면 배포 전:** 기존 화면이 읽는 컬럼은 유지합니다. `team`도 삭제하지 않고 `미정`을 남기므로 기존 조회 SQL이 깨지지 않습니다. 회사·전문분야는 교정된 값으로 보이며, 협업팀 UI는 새 화면 배포 후 나타납니다. 서버는 예전 화면의 신규 멤버 입력과 폐기된 team 항목 쓰기를 차단합니다. 따라서 조회는 가능하지만 **새 멤버 등록·경청표 일괄 입력은 배포 후 새로고침하고 진행**해야 합니다. 이는 칸이 다시 밀리는 것을 막기 위한 전환 처리입니다.
- **0번 실제 변경부터 새 AI 배포까지:** 일반 명단 조회와 이미 반영된 자료는 유지됩니다. 예전 반영 함수가 폐기된 team 컬럼을 쓰거나 예전 AI가 team 제안을 보내면 서버가 반영을 거부할 수 있습니다. 따라서 이 구간에는 AI 분석·반영을 잠시 멈추고 새 Edge 배포 후 다시 진행합니다. 보관 원문과 기존 기록은 삭제하지 않습니다.
- **새 화면을 SQL보다 먼저 배포하지 않습니다.** 새 화면은 `chapter_role`과 협업팀 구조를 사용합니다. SQL 준비가 안 된 상태를 정상적인 빈 팀으로 처리하지 않도록 오류 안내를 제공합니다.

## 되돌리기 순서

[`collab_teams_rollback.sql`](../supabase/collab_teams_rollback.sql)은 별도의 **수동 실행 파일**입니다. 자동 실행하지 않습니다.

1. 관리자의 명단·협업팀·인터뷰 수정 작업을 멈춥니다.
2. 새 웹 화면을 이미 배포했다면, 승인 후 이전 화면 커밋 `c32870b409437cf586d65c30485bed524758cb19`를 먼저 다시 배포합니다. 기존 컬럼이 남아 있어 이전 화면은 전환 DB를 읽을 수 있습니다. 아직 새 화면을 배포하지 않았다면 이 단계는 생략합니다.
3. `collab_teams_rollback.sql`을 SQL Editor에서 실행합니다. 백업 시점의 members와 기존 함수 정의를 복원하고, 이번에 만든 협업팀 구조와 `chapter_role`을 제거합니다. **원본 백업은 보존합니다.**
4. 새 Edge를 배포했다면 승인 후 이전 커밋의 `analyze-interview`로 복원합니다. 함수 JWT 검증은 유지합니다.
5. 아래 복구 확인 쿼리를 실행하고 이전 사이트를 새로고침합니다.

롤백은 백업 시점으로 되돌리는 작업입니다. 적용 후 새로 등록되거나 연결된 데이터가 있으면 먼저 확인해야 합니다. 특히 이은성에게 새 계정·인터뷰 등이 연결되면 이를 임의로 삭제하지 않고 롤백이 중단됩니다.

롤백 직전 상태도 비공개로 별도 보관합니다. 멤버는 `private.members_before_collab_rollback_20260929`, 협업팀·소속·설정은 각각 `private.collab_teams_before_collab_rollback_20260929`, `private.collab_team_members_before_collab_rollback_20260929`, `private.collab_team_state_before_collab_rollback_20260929`에 남습니다. 협업팀 설치 전에 롤백하면 아직 없는 협업팀 테이블의 백업은 만들지 않습니다. 이 백업에는 관리자 편집 내용과 단톡방 링크가 있으므로 공개 권한을 부여하지 않습니다.

```sql
select count(*) as members,
       count(*) filter(where name='김철홍') as kim_restored,
       count(*) filter(where name='이은성') as eunseong_removed,
       count(*) filter(where name='이 훈') as original_name_restored
from public.members;
-- 기대값: 33 / 1 / 0 / 1

select to_regclass('public.collab_teams') is null as teams_removed,
       to_regclass('public.collab_team_members') is null as memberships_removed,
       not exists(select 1 from information_schema.columns
                  where table_schema='public' and table_name='members'
                    and column_name='chapter_role') as role_column_removed,
       (select count(*) from private.members_backup_20260929
        where name='김철홍') as kim_still_in_backup;
-- 기대값: true / true / true / 1
```

## 이 작업에서 제외한 것

협업팀 내 121 진행표, 비지터 공동 호스팅 기록, 멤버의 새 팀 제안은 이번에 구현하지 않습니다. 이번 구조는 UUID와 별도 소속 관계를 사용해 후속 기능에서 확장할 수 있게 합니다.
