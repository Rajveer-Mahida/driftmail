-- The instance-wide key/value store from the single-user era.
--
-- Its contents moved to `config` (behaviour switches) and `user_settings`
-- (per-person preferences) when the instance became multi-user, and nothing has
-- read this table since.

DROP TABLE IF EXISTS settings;
