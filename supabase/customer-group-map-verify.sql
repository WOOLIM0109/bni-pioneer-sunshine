-- Read-only verification. Run manually after applying, then again after Edge deployment.
select
  (select count(*) from public.customer_groups) as group_count,
  (select count(*) from public.customer_group_map) as mapping_count,
  (select count(*) from public.customer_group_map where source='ai') as ai_classified_count,
  (select count(*) from public.members) as member_count,
  (select count(*)=17 from public.customer_groups where is_seed) as seed_groups_ok,
  (select count(*) between 17 and 20 from public.customer_groups) as group_limit_ok,
  (select bool_and(label_key=public.customer_label_key(label)) from public.customer_group_map) as normalization_ok,
  (select bool_and(relrowsecurity) from pg_class where oid in ('public.customer_groups'::regclass,'public.customer_group_map'::regclass,'private.customer_classification_state'::regclass)) as rls_ok,
  (has_table_privilege('anon','public.customer_group_map','SELECT') and has_table_privilege('authenticated','public.customer_group_map','SELECT')) as public_read_ok,
  (not has_table_privilege('anon','public.customer_group_map','INSERT') and not has_table_privilege('authenticated','public.customer_group_map','UPDATE')
    and not has_table_privilege('authenticated','public.customer_groups','INSERT')) as browser_writes_blocked_ok,
  (not has_function_privilege('authenticated','public.begin_customer_label_classification()','EXECUTE')
    and not has_function_privilege('anon','public.finish_customer_label_classification(uuid,jsonb)','EXECUTE')
    and has_function_privilege('service_role','public.begin_customer_label_classification()','EXECUTE')) as edge_only_rpc_ok,
  (select count(distinct public.customer_label_key(input.label)) from public.members m cross join lateral unnest(m.customers) as input(label)
    where public.customer_label_key(input.label)<>'' and not exists(select 1 from public.customer_group_map map where map.label_key=public.customer_label_key(input.label))) as pending_labels;

-- Public customer types only. No interview text, referrals, or real customer companies.
select label,group_name,source,member_count,updated_at from public.customer_group_map where source='ai' order by updated_at desc,label_key;
