-- ============================================================
-- DUCHESS & BUTLER — Supabase Database Setup
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- 1. USERS TABLE (extends Supabase Auth)
create table public.users (
  id uuid references auth.users(id) on delete cascade primary key,
  name text not null,
  role text not null check (role in ('admin', 'operations', 'driver')),
  active boolean default true,
  created_at timestamptz default now()
);

-- 2. ORDERS TABLE
create table public.orders (
  id uuid default gen_random_uuid() primary key,
  ref text,
  event_name text not null,
  client_name text not null,
  venue text,
  event_date date,
  delivery_date date,
  delivery_time time,
  collection_date date,
  collection_time time,
  driver_id uuid references public.users(id),
  status text default 'pending' check (status in ('pending','confirmed','amended','cancelled','collected')),
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Auto-generate order ref (ORD-001, ORD-002, etc.)
create sequence orders_ref_seq start 1;
create or replace function set_order_ref()
returns trigger as $$
begin
  if new.ref is null then
    new.ref := 'ORD-' || lpad(nextval('orders_ref_seq')::text, 3, '0');
  end if;
  return new;
end;
$$ language plpgsql;

create trigger orders_set_ref
  before insert on public.orders
  for each row execute function set_order_ref();

-- Auto-update updated_at
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger orders_updated_at
  before update on public.orders
  for each row execute function update_updated_at();

-- 3. ORDER ITEMS TABLE
create table public.order_items (
  id uuid default gen_random_uuid() primary key,
  order_id uuid references public.orders(id) on delete cascade,
  item_name text not null,
  category text check (category in ('crockery','cutlery','glassware','linens','furniture','other')),
  quantity integer default 0
);

-- 4. INVENTORY TABLE
create table public.inventory (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  category text check (category in ('crockery','cutlery','glassware','linens','furniture','other')),
  total_stock integer default 0,
  available integer default 0,
  low_stock_threshold integer default 50,
  created_at timestamptz default now()
);

-- 5. ACTIVITY LOG TABLE
create table public.activity_log (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.users(id),
  action text not null,
  entity_type text,
  entity_id uuid,
  created_at timestamptz default now()
);

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================

alter table public.users enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.inventory enable row level security;
alter table public.activity_log enable row level security;

-- Users: can read all, update own profile
create policy "Users can view all profiles" on public.users for select using (true);
create policy "Users can update own profile" on public.users for update using (auth.uid() = id);
create policy "Users can insert own profile" on public.users for insert with check (auth.uid() = id);

-- Orders: authenticated users can read all
create policy "Authenticated can view orders" on public.orders for select using (auth.role() = 'authenticated');
create policy "Authenticated can insert orders" on public.orders for insert with check (auth.role() = 'authenticated');
create policy "Authenticated can update orders" on public.orders for update using (auth.role() = 'authenticated');

-- Order items: authenticated users
create policy "Authenticated can view order items" on public.order_items for select using (auth.role() = 'authenticated');
create policy "Authenticated can insert order items" on public.order_items for insert with check (auth.role() = 'authenticated');
create policy "Authenticated can update order items" on public.order_items for update using (auth.role() = 'authenticated');
create policy "Authenticated can delete order items" on public.order_items for delete using (auth.role() = 'authenticated');

-- Inventory: authenticated users
create policy "Authenticated can view inventory" on public.inventory for select using (auth.role() = 'authenticated');
create policy "Authenticated can manage inventory" on public.inventory for all using (auth.role() = 'authenticated');

-- Activity log: authenticated users
create policy "Authenticated can view logs" on public.activity_log for select using (auth.role() = 'authenticated');
create policy "Authenticated can insert logs" on public.activity_log for insert with check (auth.role() = 'authenticated');

-- ============================================================
-- SAMPLE DATA (optional — remove if you want to start clean)
-- ============================================================

insert into public.inventory (name, category, total_stock, available, low_stock_threshold) values
  ('Dinner Plates (10")', 'crockery', 800, 320, 100),
  ('Side Plates (7")', 'crockery', 600, 250, 80),
  ('Soup Bowls', 'crockery', 400, 45, 80),
  ('Cutlery Sets (5-piece)', 'cutlery', 1000, 480, 150),
  ('Serving Spoons', 'cutlery', 200, 80, 40),
  ('White Linen Tablecloths', 'linens', 300, 120, 60),
  ('Ivory Napkins', 'linens', 1200, 60, 100),
  ('Chiavari Chairs (Gold)', 'furniture', 300, 140, 60),
  ('Chiavari Chairs (White)', 'furniture', 200, 200, 40),
  ('Champagne Flutes', 'glassware', 600, 300, 80);
