select
  to_regclass('auth.users') is not null as ok,
  'auth.users is present after the compatibility bootstrap' as check;
