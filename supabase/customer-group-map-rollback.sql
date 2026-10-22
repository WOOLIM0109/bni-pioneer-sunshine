-- Manual rollback only. Revert the application/Edge deployment separately.
-- Removes this feature's mapping/AI results; preserves members and all interview data.
begin;
drop function if exists public.cancel_customer_label_classification(uuid);
drop function if exists public.finish_customer_label_classification(uuid,jsonb);
drop function if exists public.begin_customer_label_classification();
drop function if exists private.customer_label_snapshot();
drop table if exists private.customer_classification_state;
drop table if exists public.customer_group_map;
drop table if exists public.customer_groups;
drop function if exists private.guard_customer_group_limit();
drop function if exists public.customer_label_key(text);
notify pgrst,'reload schema';
commit;
select to_regclass('public.customer_group_map') is null as mapping_removed_ok,
  to_regclass('public.customer_groups') is null as groups_removed_ok,
  to_regclass('public.members') is not null as members_preserved_ok,
  (select count(*) from public.members) as member_count;
