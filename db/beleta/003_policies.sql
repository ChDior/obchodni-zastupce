insert into ai_policies (key, value, description) values
  ('vat.default_rate',        '21', 'Výchozí sazba DPH (doprava, položky bez vlastní sazby)'),
  ('followup.max_pending_per_customer', '5', 'Max. počet otevřených follow-upů na zákazníka'),
  ('followup.max_days_ahead', '90', 'Max. vzdálenost termínu follow-upu ve dnech'),
  ('customer.ai_create_per_hour', '20', 'Max. počet zákazníků vytvořených AI za hodinu')
on conflict (key) do nothing;
