-- Web, na kterém AI poradce běží (profil webu). Přepnutí v administraci: Pravidla AI → site.profile
insert into ai_policies (key, value, description) values
  ('site.profile', '"cihlovestavby"', 'Profil webu, na kterém běží AI poradce (cihlovestavby | beleta) – značka, uvítání, povolené vložení widgetu')
on conflict (key) do nothing;
