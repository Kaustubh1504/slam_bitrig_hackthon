insert into public.tracks (id, title, artist, itunes_search_term, bpm, key_name, camelot, energy, description)
values
  ('september-ewf',          'September',   'Earth, Wind & Fire', 'September Earth Wind & Fire', 126, 'A major',  '11B', 0.6,
   'bass-forward disco groove, horns, joyful group vocals'),
  ('right-round-flo-rida',   'Right Round', 'Flo Rida',           'Right Round Flo Rida',        123, 'G major',  '9B',  0.85,
   'electro-pop rap, big synth hook, Kesha chorus'),
  ('dracula-tame-impala',    'Dracula',     'Tame Impala',        'Dracula Tame Impala',         115, 'E♭ minor', '2A',  0.5,
   'groovy disco-electropop, deep bassline, airy vocals'),
  ('man-i-need-olivia-dean', 'Man I Need',  'Olivia Dean',        'Man I Need Olivia Dean',      119, 'D♭ major', '3B',  0.45,
   'warm soul-pop, bass-heavy, rich lead vocal')
on conflict (id) do update set
  title = excluded.title,
  artist = excluded.artist,
  itunes_search_term = excluded.itunes_search_term,
  bpm = excluded.bpm,
  key_name = excluded.key_name,
  camelot = excluded.camelot,
  energy = excluded.energy,
  description = excluded.description;

insert into public.pairs (id, track_a, track_b, featured, sort_order)
values
  ('september-x-right-round', 'september-ewf',       'right-round-flo-rida',   true, 1),
  ('dracula-x-man-i-need',    'dracula-tame-impala', 'man-i-need-olivia-dean', true, 2)
on conflict (id) do update set
  track_a = excluded.track_a,
  track_b = excluded.track_b,
  featured = excluded.featured,
  sort_order = excluded.sort_order;
