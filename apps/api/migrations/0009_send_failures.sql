-- A permanently-rejected outbound message used to be reverted to 'pending' on any
-- error, so the every-minute cron retried it forever and the UI showed it as
-- merely waiting. Non-retryable failures now stop, and say why.

ALTER TABLE messages ADD COLUMN send_error TEXT;

CREATE INDEX IF NOT EXISTS idx_msg_failed ON messages(send_state) WHERE send_state = 'failed';
