create extension if not exists vector with schema extensions;

create table if not exists public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  file_name text not null,
  media_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  page_count integer,
  character_count integer not null default 0 check (character_count >= 0),
  extracted_text text not null,
  status text not null default 'processing' check (status in ('processing','ready','failed')),
  error_code text,
  embedding_model text not null,
  embedding_dimensions integer not null check (embedding_dimensions between 128 and 3072),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  document_id uuid not null references public.knowledge_documents(id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null check (length(trim(content)) > 0),
  character_count integer not null check (character_count > 0),
  embedding_model text not null,
  embedding_dimensions integer not null check (embedding_dimensions = 768),
  embedding extensions.vector(768) not null,
  created_at timestamptz not null default now(),
  unique(document_id, chunk_index)
);

create index if not exists idx_knowledge_documents_tenant_created on public.knowledge_documents(tenant_id, created_at desc);
create index if not exists idx_knowledge_chunks_tenant_document on public.knowledge_chunks(tenant_id, document_id);
create index if not exists idx_knowledge_chunks_embedding_hnsw on public.knowledge_chunks using hnsw (embedding extensions.vector_cosine_ops);

alter table public.knowledge_documents enable row level security;
alter table public.knowledge_chunks enable row level security;

drop policy if exists knowledge_documents_select_members on public.knowledge_documents;
create policy knowledge_documents_select_members on public.knowledge_documents for select to authenticated using (
  exists(select 1 from public.tenant_users tu where tu.tenant_id=knowledge_documents.tenant_id and tu.user_id=(select auth.uid()))
);
drop policy if exists knowledge_documents_write_admins on public.knowledge_documents;
create policy knowledge_documents_write_admins on public.knowledge_documents for all to authenticated using (
  exists(select 1 from public.tenant_users tu where tu.tenant_id=knowledge_documents.tenant_id and tu.user_id=(select auth.uid()) and tu.role in ('owner','admin'))
) with check (
  exists(select 1 from public.tenant_users tu where tu.tenant_id=knowledge_documents.tenant_id and tu.user_id=(select auth.uid()) and tu.role in ('owner','admin'))
);
drop policy if exists knowledge_chunks_select_members on public.knowledge_chunks;
create policy knowledge_chunks_select_members on public.knowledge_chunks for select to authenticated using (
  exists(select 1 from public.tenant_users tu where tu.tenant_id=knowledge_chunks.tenant_id and tu.user_id=(select auth.uid()))
);
drop policy if exists knowledge_chunks_write_admins on public.knowledge_chunks;
create policy knowledge_chunks_write_admins on public.knowledge_chunks for all to authenticated using (
  exists(select 1 from public.tenant_users tu where tu.tenant_id=knowledge_chunks.tenant_id and tu.user_id=(select auth.uid()) and tu.role in ('owner','admin'))
) with check (
  exists(select 1 from public.tenant_users tu where tu.tenant_id=knowledge_chunks.tenant_id and tu.user_id=(select auth.uid()) and tu.role in ('owner','admin'))
);

grant select,insert,update,delete on public.knowledge_documents to authenticated;
grant select,insert,update,delete on public.knowledge_chunks to authenticated;

create or replace function public.match_knowledge_chunks(
  p_tenant_id uuid,
  p_embedding extensions.vector(768),
  p_embedding_model text,
  p_threshold double precision,
  p_limit integer
) returns table(id uuid,document_id uuid,file_name text,content text,similarity double precision)
language sql stable security invoker set search_path=public,extensions as $$
  select kc.id,kc.document_id,kd.file_name,kc.content,1-(kc.embedding <=> p_embedding) as similarity
  from public.knowledge_chunks kc
  join public.knowledge_documents kd on kd.id=kc.document_id and kd.tenant_id=kc.tenant_id
  where kc.tenant_id=p_tenant_id and kc.embedding_model=p_embedding_model and kd.status='ready'
    and 1-(kc.embedding <=> p_embedding)>=p_threshold
  order by kc.embedding <=> p_embedding
  limit greatest(1,least(p_limit,20));
$$;
revoke all on function public.match_knowledge_chunks(uuid,extensions.vector,text,double precision,integer) from public,anon,authenticated;
grant execute on function public.match_knowledge_chunks(uuid,extensions.vector,text,double precision,integer) to service_role;
