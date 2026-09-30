-- Brings a database that applied an earlier draft of 0011 to the state the
-- current file produces. Run by `migrate.mjs --reconcile`, after the current
-- (idempotent) 0011 file itself has been re-applied in the same transaction.
--
-- Views hold no data, so dropping them loses nothing. 0013 drops them too; this
-- repeats it so the reconciled 0011 state is correct on its own.
drop view if exists public.entities_default_workspace;
drop view if exists public.business_units_default_workspace;
