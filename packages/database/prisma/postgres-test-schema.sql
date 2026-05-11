create table if not exists cda_customers (
  id serial primary key,
  name text not null,
  region text not null,
  created_at timestamptz not null default now()
);

create table if not exists cda_orders (
  id serial primary key,
  customer_id integer not null references cda_customers(id),
  amount numeric(12, 2) not null,
  status text not null,
  created_at timestamptz not null default now()
);

create table if not exists cda_order_events (
  id serial primary key,
  order_id integer not null references cda_orders(id),
  event_name text not null,
  created_at timestamptz not null default now()
);

insert into cda_customers (name, region)
values
  ('Acme Co', 'east'),
  ('Globex', 'west')
on conflict do nothing;

insert into cda_orders (customer_id, amount, status)
select id, 120.50, 'paid'
from cda_customers
where name = 'Acme Co'
on conflict do nothing;

insert into cda_order_events (order_id, event_name)
select id, 'created'
from cda_orders
where status = 'paid'
on conflict do nothing;
