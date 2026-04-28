-- ATA catalog alignment to RMS Current naming
-- Scope: only ata_items name normalization + explicit missing inserts (kg = 0)
-- Safety rules:
-- - Do not change category/unit_name/pieces_per_unit/weight_per_unit on existing rows
-- - Do not delete rows
-- - Do not merge rows

begin;

-- ============================================================
-- 1) Explicit, safe renames (existing ATA rows only)
-- ============================================================

-- Charger plates
update public.ata_items set name = 'Amelie Blush Vintage Glass Charger Plate'
where active = true and name = 'Amelie Blush Charger Plate';

update public.ata_items set name = 'Bronte Gold Rimmed Charger Plate'
where active = true and name = 'Bronte Gold Charger Plate';

update public.ata_items set name = 'Diva Charger/ Dinner Plate 29cm - Yellow'
where active = true and name = 'Diva Yellow Charger Plate';

update public.ata_items set name = 'Valentina Sage Green and Gold Charger Plate'
where active = true and name = 'Valentina Sage Green Gold Charger Plate';

update public.ata_items set name = 'Valentina Sage Green and Gold Charger Plate'
where active = true and name = 'Valentina Sage Green Gold Charger Plate ( 5 )';

update public.ata_items set name = 'Clear Beaded Charger Plate'
where active = true and name = 'Clear Beadead Charger Plate';

-- Cutlery typo fixes and RMS wording
update public.ata_items set name = 'Piccadilly'
where active = true and name = 'Picadilly';

update public.ata_items set name = 'French Helios'
where active = true and name = 'French Hellios';

-- Second-pass explicit fixes for legacy "French Hellios" rows that remained.
update public.ata_items set name = 'French Helios Dinner Fork'
where active = true and name = 'French Hellios Dinner Fork';

update public.ata_items set name = 'French Helios Dinner Knife'
where active = true and name = 'French Hellios Dinner Knife';

update public.ata_items set name = 'French Helios Dessert Fork'
where active = true and name = 'French Hellios Dessert Fork';

update public.ata_items set name = 'French Helios Dessert Spoon'
where active = true and name = 'French Hellios Dessert Spoon';

update public.ata_items set name = 'French Helios Starter Knife'
where active = true and name = 'French Hellios Starter Knife';

update public.ata_items set name = 'French Helios Tea Spoon'
where active = true and name = 'French Hellios Tea Spoon';

update public.ata_items set name = 'French Helios Butter Knife'
where active = true and name = 'French Hellios Butter Knife';

update public.ata_items set name = 'French Helios Cherry Dinner Fork'
where active = true and name = 'French Hellios Cherry Dinner Fork';

update public.ata_items set name = 'French Helios Cherry Dinner Knife'
where active = true and name = 'French Hellios Cherry Dinner Knife';

update public.ata_items set name = 'French Helios Cherry Dessert Fork'
where active = true and name = 'French Hellios Cherry Dessert Fork';

update public.ata_items set name = 'French Helios Cherry Dessert Spoon'
where active = true and name = 'French Hellios Cherry Dessert Spoon';

update public.ata_items set name = 'French Helios Cherry Butter Knife'
where active = true and name = 'French Hellios Cherry Butter Knife';

update public.ata_items set name = 'French Helios Cherry Starter Knife'
where active = true and name = 'French Hellios Cherry Starter Knife';

update public.ata_items set name = 'Gaia White Dessert Spoon'
where active = true and name = 'Gaia White Desser Spon';

update public.ata_items set name = 'Grace Matt Gold Dinner Spoon'
where active = true and name = 'Grace Matt GOld Dinner Spoon';

-- Glassware typo/format fixes
update public.ata_items set name = 'Green Emerald Goblet'
where active = true and name = 'Green Esmerald Globet';

update public.ata_items set name = 'Tumbler Burgundy'
where active = true and name = 'Tumbler Brgundy';

update public.ata_items set name = 'Nude Grand Vin'
where active = true and name = 'Nude G.vin';

update public.ata_items set name = 'Nude Champagne Flute'
where active = true and name = 'Nude Flute';

update public.ata_items set name = 'Nude Red Wine Glass'
where active = true and name = 'Nude Red Wine';

update public.ata_items set name = 'Nude White Wine Glass'
where active = true and name = 'Nude White Wine';

update public.ata_items set name = 'Tulip Water Glass - Green'
where active = true and name = 'Tulip Green';

update public.ata_items set name = 'Tulip Water Glass - Dusty Rose'
where active = true and name = 'Tulip Pink';

update public.ata_items set name = 'Tulip Water Glass - Nude'
where active = true and name = 'Tulipe Nude';

-- Other typo/format fixes
update public.ata_items set name = 'Pebble Jug'
where active = true and name = 'Peble Jug';

update public.ata_items set name = 'Primrose Green Tea Cup'
where active = true and name = 'Primrose green Tea Cup';

update public.ata_items set name = 'Mini Tulip Candle Holder'
where active = true and name = 'Mini Tulio Candle Holder';

update public.ata_items set name = 'Hydrangea Leaf Bread Plate Small'
where active = true and name = 'Hydrangea Leaf Bread Plate - Small';

update public.ata_items set name = 'Hydrangea Leaf Bread Plate Small'
where active = true and name = 'Hydrangea Leaf Bread Plate - Small ( 32 )';

-- Dinnerware plural normalization
update public.ata_items set name = 'Burleigh Dinner Plate'
where active = true and name = 'Burleigh Dinner Plates';

update public.ata_items set name = 'Pearl Dinner Plate'
where active = true and name = 'Pearl Dinner Plates';

update public.ata_items set name = 'Etoile White & Gold Dessert Plate'
where active = true and name = 'Etoile White Dessert Plate';

update public.ata_items set name = 'Etoile White & Gold Dinner Plate'
where active = true and name = 'Etoile White Dinner Plate';

update public.ata_items set name = 'Etoile White & Gold Side Plate'
where active = true and name = 'Etoile White Side Plate';

-- ============================================================
-- 2) Remove operational suffixes from canonical name only
--    Keeps each original row, capacity and weight untouched.
-- ============================================================
update public.ata_items
set name = regexp_replace(name, '\s*\(\s*\d+\s*\)\s*$', '', 'g')
where active = true
  and name ~ '\(\s*\d+\s*\)\s*$';

-- ============================================================
-- 3) Add explicit missing RMS items (idempotent inserts, kg = 0)
--    Family packing rules:
--      - Botanica/Botanica Fleur Rattan Charger: 40 pcs/box
--      - Table Lamps: 8 pcs/box
--      - Hurricane Candle Sleeves: 7 pcs/box
--    Existing rows remain untouched: no existing weight/capacity/category changes.
-- ============================================================

insert into public.ata_items (name, category, unit_name, pieces_per_unit, weight_per_unit, notes, active)
select 'Botanica Fleur Rattan Charger', 'charger_plates', 'box', 40, 0, 'RMS-aligned canonical ATA name', true
where not exists (
  select 1 from public.ata_items where lower(trim(name)) = lower(trim('Botanica Fleur Rattan Charger'))
);

insert into public.ata_items (name, category, unit_name, pieces_per_unit, weight_per_unit, notes, active)
select 'Table Lamp', 'table_lamps', 'box', 8, 0, 'RMS-aligned canonical ATA name', true
where not exists (
  select 1 from public.ata_items where lower(trim(name)) = lower(trim('Table Lamp'))
);

insert into public.ata_items (name, category, unit_name, pieces_per_unit, weight_per_unit, notes, active)
select 'Hurricane Candle Sleeve', 'other', 'box', 7, 0, 'RMS-aligned canonical ATA name', true
where not exists (
  select 1 from public.ata_items where lower(trim(name)) = lower(trim('Hurricane Candle Sleeve'))
);

commit;

