create table if not exists cda_customers (
  id serial primary key,
  name text not null unique,
  region text not null,
  segment text not null default 'standard',
  created_at timestamptz not null default now()
);

alter table cda_customers
  add column if not exists segment text not null default 'standard';

create table if not exists cda_orders (
  id serial primary key,
  customer_id integer not null references cda_customers(id),
  amount numeric(12, 2) not null,
  status text not null,
  channel text not null default 'web',
  created_at timestamptz not null default now()
);

alter table cda_orders
  add column if not exists channel text not null default 'web';

create table if not exists cda_order_events (
  id serial primary key,
  order_id integer not null references cda_orders(id),
  event_name text not null,
  created_at timestamptz not null default now()
);

do $$
declare
  order_count integer;
  daily_count_mismatch integer;
begin
  raise notice 'Seeding ClusterDataAgent PostgreSQL fixture tables.';

  truncate table cda_order_events, cda_orders, cda_customers restart identity cascade;

  insert into cda_customers (name, region, segment, created_at)
  values
    ('Acme Co', 'east', 'enterprise', '2026-04-24 08:00:00+00'),
    ('Globex', 'west', 'enterprise', '2026-04-24 08:05:00+00'),
    ('Initech', 'south', 'mid-market', '2026-04-24 08:10:00+00'),
    ('Umbrella Retail', 'north', 'standard', '2026-04-24 08:15:00+00'),
    ('Soylent Direct', 'central', 'mid-market', '2026-04-24 08:20:00+00'),
    ('Hooli Labs', 'east', 'standard', '2026-04-24 08:25:00+00'),
    ('Stark Supply', 'west', 'enterprise', '2026-04-24 08:30:00+00'),
    ('Wayne Wholesale', 'north', 'enterprise', '2026-04-24 08:35:00+00');

  insert into cda_orders (customer_id, amount, status, channel, created_at)
  select
    ((day_index * 4 + order_slot - 1) % 8) + 1 as customer_id,
    round(
      (
        86
        + day_index * 9.75
        + order_slot * 18.4
        + case when day_index in (6, 13, 19) then 42 else 0 end
      )::numeric,
      2
    ) as amount,
    case
      when (day_index + order_slot) % 11 = 0 then 'refunded'
      when (day_index + order_slot) % 7 = 0 then 'pending'
      else 'paid'
    end as status,
    (array['web', 'mobile', 'sales', 'partner'])[
      ((day_index + order_slot - 2) % 4) + 1
    ] as channel,
    (
      timestamp with time zone '2026-04-25 09:00:00+00'
      + day_index * interval '1 day'
      + (order_slot - 1) * interval '3 hours'
    ) as created_at
  from generate_series(0, 19) as days(day_index)
  cross join generate_series(1, 4) as slots(order_slot);

  insert into cda_order_events (order_id, event_name, created_at)
  select id, 'created', created_at - interval '12 minutes'
  from cda_orders;

  insert into cda_order_events (order_id, event_name, created_at)
  select id, 'paid', created_at + interval '18 minutes'
  from cda_orders
  where status = 'paid';

  insert into cda_order_events (order_id, event_name, created_at)
  select id, 'review_required', created_at + interval '22 minutes'
  from cda_orders
  where status = 'pending';

  insert into cda_order_events (order_id, event_name, created_at)
  select id, 'refunded', created_at + interval '1 day'
  from cda_orders
  where status = 'refunded';

  select count(*) into order_count from cda_orders;

  if order_count <> 80 then
    raise exception 'Expected 80 cda_orders fixture rows, got %', order_count;
  end if;

  select count(*) into daily_count_mismatch
  from (
    select created_at::date as order_date, count(*) as orders_per_day
    from cda_orders
    group by created_at::date
    having count(*) <> 4
  ) as daily_counts;

  if daily_count_mismatch <> 0 then
    raise exception 'Expected exactly 4 cda_orders rows per day, got % mismatched days',
      daily_count_mismatch;
  end if;

  raise notice 'Seeded % cda_orders rows across 20 days with 4 rows per day.',
    order_count;
end $$;
